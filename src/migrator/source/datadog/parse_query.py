"""Bounded Datadog metric query parser (handoff plan 02).

Grammar (fixed; widening it needs a test first):

    query       := [aggregator ":"] metric "{" filterList "}" [" by {" tagList "}"] function*
    aggregator  := "avg" | "sum" | "min" | "max"
    metric      := ident ("." segment)*     -- segment := [A-Za-z0-9_]+ (system.load.1)
    ident       := [A-Za-z_][A-Za-z0-9_]*
    filterList  := orExpr                 -- spaces allowed around tokens
    orExpr      := andExpr (" OR " andExpr)*
    andExpr     := unary (("," | " AND ") unary)*
    unary       := "NOT " unary | "!" tagFilter | "(" orExpr ")" | "*" | filter
    filter      := "$" varName | tagFilter
    tagFilter   := tagKey ":" tagValue
    varName     := ident ([.-] [A-Za-z0-9_]+)*
    tagKey      := [A-Za-z][A-Za-z0-9_./-]*
    tagValue    := [A-Za-z0-9_./:@*-]+     -- `*` is a glob

The filter expression must reduce to a conjunction (#178): `,` and `AND` join, `!`/`NOT`
negate a tag filter, `*` matches everything, and `OR` is only accepted between positive
filters of one tag key (one anchored alternation). Datadog evaluates `NOT` before `AND`
before `OR` (https://docs.datadoghq.com/metrics/advanced-filtering/#boolean-filtered-queries).
Cross-key `OR`, negated variables and negated conjunctions block with a message.
    tagList     := tagKey ("," " "? tagKey)*
    function    := "." ident "(" [arg ("," " "? arg)*] ")"
    arg         := [A-Za-z0-9_.'-]+

The parser is total: it never raises on string input and always consumes the whole
string or reports the first offending offset (a 0-based UTF-16 index).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from migrator.source.datadog.model import (
    SPACE_AGGREGATORS,
    Filter,
    MetricQuery,
    ParseError,
    ParseErrorCode,
    ParseOk,
    ParseResult,
    QueryFunction,
    SpaceAggregator,
    TagFilter,
    VariableFilter,
)

_LEADING_FUNCTION = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\(")


def _is_ident_start(ch: str) -> bool:
    return ch == "_" or ("A" <= ch <= "Z") or ("a" <= ch <= "z")


def _is_ident_char(ch: str) -> bool:
    return _is_ident_start(ch) or ("0" <= ch <= "9")


def _is_alpha(ch: str) -> bool:
    return ("A" <= ch <= "Z") or ("a" <= ch <= "z")


def _is_tag_key_char(ch: str) -> bool:
    return _is_ident_char(ch) or ch in "./-"


def _is_tag_value_char(ch: str) -> bool:
    return _is_ident_char(ch) or ch in "./:@*-"


def _is_arg_char(ch: str) -> bool:
    return _is_ident_char(ch) or ch in ".'-"


class _Fail(Exception):
    def __init__(self, pos: int, message: str | None = None) -> None:
        self.pos = pos
        self.message = message


class _Scanner:
    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def peek(self) -> str:
        return self.text[self.pos] if self.pos < len(self.text) else ""

    def at_end(self) -> bool:
        return self.pos >= len(self.text)

    def expect(self, literal: str) -> None:
        for ch in literal:
            if self.peek() != ch:
                raise _Fail(self.pos)
            self.pos += 1

    def take_while(self, first: Callable[[str], bool], rest: Callable[[str], bool]) -> str:
        start = self.pos
        if self.at_end() or not first(self.peek()):
            raise _Fail(self.pos)
        self.pos += 1
        while not self.at_end() and rest(self.peek()):
            self.pos += 1
        return self.text[start : self.pos]

    def ident(self) -> str:
        return self.take_while(_is_ident_start, _is_ident_char)

    def spaces(self) -> None:
        while self.peek() == " ":
            self.pos += 1

    def keyword(self, word: str) -> bool:
        """Consume ` word ` (a boolean keyword surrounded by spaces) if it is next."""
        start = self.pos
        self.spaces()
        if self.text.startswith(word + " ", self.pos) or self.text.startswith(word + "(", self.pos):
            if self.pos > start or word == "NOT":
                self.pos += len(word)
                self.spaces()
                return True
        self.pos = start
        return False

    def separator(self) -> bool:
        """Consume ',' plus one optional space; return whether a comma was present."""
        if self.peek() != ",":
            return False
        self.pos += 1
        if self.peek() == " ":
            self.pos += 1
        return True


def _utf16_offset(text: str, index: int) -> int:
    return len(text[:index].encode("utf-16-le")) // 2


def _syntax_error(text: str, index: int, detail: str | None = None) -> ParseError:
    offset = _utf16_offset(text, index)
    if detail is not None:
        message = f"{detail} (offset {offset})."
    elif index >= len(text):
        message = f"Unexpected end of query at offset {offset}."
    else:
        message = f"Unexpected '{text[index]}' at offset {offset}."
    return ParseError(code="UNSUPPORTED_QUERY_SYNTAX", offset=offset, message=message)


def _function_error(name: str) -> ParseError:
    code: ParseErrorCode = "UNSUPPORTED_QUERY_FUNCTION"
    return ParseError(code=code, offset=0, message=f"Function '{name}' is not supported.")


def _parse_tag(s: _Scanner) -> TagFilter:
    key = s.take_while(_is_alpha, _is_tag_key_char)
    s.expect(":")
    value = s.take_while(_is_tag_value_char, _is_tag_value_char)
    return TagFilter(key=key, value=value)


def _parse_filter(s: _Scanner) -> Filter:
    if s.peek() == "$":
        s.pos += 1
        name = s.ident()
        while s.peek() in (".", "-") and _is_ident_char(s.text[s.pos + 1 : s.pos + 2] or " "):
            sep = s.peek()
            s.pos += 1
            name += sep + s.take_while(_is_ident_char, _is_ident_char)
        return VariableFilter(name=name)
    return _parse_tag(s)


# Filter expression tree: ("lit", Filter), ("all",), ("and", [...]), ("or", [...]), ("not", n).
_Node = tuple[Any, ...]


def _unary(s: _Scanner) -> _Node:
    s.spaces()
    start = s.pos
    if s.keyword("NOT"):
        return ("not", _unary(s), start)
    if s.peek() == "!":
        s.pos += 1
        return ("not", ("lit", _parse_tag(s), start), start)
    if s.peek() == "(":
        s.pos += 1
        node = _or_expr(s)
        s.spaces()
        s.expect(")")
        return node
    if s.peek() == "*" and s.text[s.pos + 1 : s.pos + 2] in ("", ",", "}", " "):
        s.pos += 1
        return ("all", start)
    return ("lit", _parse_filter(s), start)


def _and_expr(s: _Scanner) -> _Node:
    items = [_unary(s)]
    while True:
        before = s.pos
        s.spaces()
        if s.peek() == ",":
            s.pos += 1
        else:
            s.pos = before
            if not s.keyword("AND"):
                break
        items.append(_unary(s))
    return items[0] if len(items) == 1 else ("and", items)


def _or_expr(s: _Scanner) -> _Node:
    items = [_and_expr(s)]
    while s.keyword("OR"):
        items.append(_and_expr(s))
    return items[0] if len(items) == 1 else ("or", items, s.pos)


def _conjunction(node: _Node, negate: bool = False) -> list[Filter]:
    """The filters whose AND equals `node` (negated when `negate`), or _Fail."""
    kind = node[0]
    if kind == "all":
        if negate:
            raise _Fail(node[1], "Negated '*' matches nothing")
        return []
    if kind == "lit":
        flt = node[1]
        if isinstance(flt, VariableFilter):
            if negate:
                raise _Fail(node[2], "Negated template variables are not supported")
            return [flt]
        return [replace(flt, negated=flt.negated != negate)]
    if kind == "not":
        return _conjunction(node[1], not negate)
    if kind == "and":
        if negate:  # NOT (a AND b) is an OR of negations
            if len(node[1]) == 1:
                return _conjunction(node[1][0], True)
            raise _Fail(node[1][0][-1], "A negated AND group is not supported")
        return [f for child in node[1] for f in _conjunction(child)]
    # "or"
    if negate:  # NOT (a OR b) == NOT a AND NOT b
        return [f for child in node[1] for f in _conjunction(child, True)]
    parts = [_conjunction(child) for child in node[1]]
    tags = [p[0] for p in parts if len(p) == 1 and isinstance(p[0], TagFilter)]
    if len(tags) != len(parts) or any(t.negated for t in tags) or len({t.key for t in tags}) != 1:
        raise _Fail(node[2], "OR is only supported between positive filters of one tag key")
    values = [v for t in tags for v in t.values]
    return [TagFilter(key=tags[0].key, value=values[0], alternatives=tuple(values[1:]))]


def _parse(s: _Scanner) -> MetricQuery:
    aggregator: SpaceAggregator | None = None
    first = s.ident()
    if s.peek() == ":":
        if first not in SPACE_AGGREGATORS:
            raise _Fail(0)
        aggregator = first
        s.pos += 1
        segments = [s.ident()]
    else:
        segments = [first]
    while s.peek() == ".":
        s.pos += 1
        segments.append(s.take_while(_is_ident_char, _is_ident_char))
    metric = ".".join(segments)

    s.expect("{")
    filters = _conjunction(_or_expr(s))
    s.spaces()
    s.expect("}")

    group_by: list[str] = []
    if s.text.startswith(" by {", s.pos):
        s.pos += len(" by {")
        group_by.append(s.take_while(_is_alpha, _is_tag_key_char))
        while s.separator():
            group_by.append(s.take_while(_is_alpha, _is_tag_key_char))
        s.expect("}")

    functions: list[QueryFunction] = []
    while s.peek() == ".":
        s.pos += 1
        name = s.ident()
        s.expect("(")
        args: list[str] = []
        if s.peek() != ")":
            args.append(s.take_while(_is_arg_char, _is_arg_char))
            while s.separator():
                args.append(s.take_while(_is_arg_char, _is_arg_char))
        s.expect(")")
        functions.append(QueryFunction(name=name, args=args))

    if not s.at_end():
        raise _Fail(s.pos)
    return MetricQuery(
        aggregator=aggregator,
        metric=metric,
        filters=filters,
        group_by=group_by,
        functions=functions,
    )


def parse_metric_query(text: str) -> ParseResult:
    leading = _LEADING_FUNCTION.match(text)
    if leading:
        return _function_error(leading.group(1))
    scanner = _Scanner(text)
    try:
        return ParseOk(query=_parse(scanner))
    except _Fail as fail:
        return _syntax_error(text, fail.pos, fail.message)


# Datadog `top()` stays blocked (#117). https://docs.datadoghq.com/dashboards/functions/rank/#top:
#   "`top()` | Graph the top N elements." BY: "`max`: Maximum of all metrics values.",
#   "`mean`: Mean of all metrics values.", "`last`: Last metrics value.", "`l2norm`: Uses the
#   norm of the timeseries", "`area`: Signed area under the curve being graphed".
# Datadog ranks each series once by one value over its points and graphs the chosen series whole.
# PromQL `topk` ranks at every step: "the range query is just like an instant query run multiple
# times at different timestamps" (https://prometheus.io/docs/prometheus/latest/querying/basics/).
# The docs leave open which points are ranked (the graphed timeframe? raw or rolled-up points?),
# how `l2norm` and `area` are computed, and the tie order. A whole-window ranking in PromQL would
# also need a window other than `$__rate_interval` (`$__range`, `@ end()`). So `top()` blocks.
TOP_DOC = "https://docs.datadoghq.com/dashboards/functions/rank/#top"
TOP_MESSAGE = (
    f"Function 'top' is not supported: Datadog ranks each series once over its points ({TOP_DOC}); "
    "PromQL topk ranks at every step, and the docs leave the ranked window open."
)
TOP_ACTION = "Remove top() to convert all series unranked, or migrate this widget manually."


def top_block(text: str) -> tuple[str, str] | None:
    """(message, suggested action) when a query or formula is wrapped in Datadog `top()`."""
    leading = _LEADING_FUNCTION.match(text)
    return (TOP_MESSAGE, TOP_ACTION) if leading and leading.group(1) == "top" else None


# Wrapping functions that stay blocked because the Datadog docs leave their semantics open.
# Rate page (https://docs.datadoghq.com/dashboards/functions/rate/): per_second/per_minute/
# per_hour: "Graph the rate at which the metric is changing per <unit>", with no formula;
# diff: "Calculates the difference between each interval on a per interval basis", "done after
# applying time aggregation and before space aggregation"; monotonic_diff: "like diff() but only
# if the delta is positive". Interpolation page
# (https://docs.datadoghq.com/dashboards/functions/interpolation/): default_zero "fills empty time
# intervals using the value 0 or, if interpolation is enabled, with interpolation". Count page
# (https://docs.datadoghq.com/dashboards/functions/count/): count_nonzero/count_not_null count
# values "at each point"; the result when no series has a value is not documented.
RATE_DOC = "https://docs.datadoghq.com/dashboards/functions/rate/"
INTERPOLATION_DOC = "https://docs.datadoghq.com/dashboards/functions/interpolation/"
COUNT_DOC = "https://docs.datadoghq.com/dashboards/functions/count/"
ANOMALY_DOC = "https://docs.datadoghq.com/monitors/types/anomaly/"
_UNDOCUMENTED_ACTION = "Migrate this widget or monitor manually."


def _rate_reason(name: str) -> str:
    unit = name.removeprefix("per_")
    return (
        f"Function '{name}' is not supported: Datadog documents it only as 'Graph the rate at "
        f"which the metric is changing per {unit}' ({RATE_DOC}); without a formula, neither a "
        "PromQL derivative nor a constant factor is known to match."
    )


def _diff_reason(name: str) -> str:
    return (
        f"Function '{name}' is not supported: Datadog takes the difference per interval after "
        f"time aggregation ({RATE_DOC}); the interval depends on the graph, so no fixed PromQL "
        "range reproduces it."
    )


def _count_reason(name: str) -> str:
    return (
        f"Function '{name}' is not supported: Datadog counts values per point across series, "
        f"but does not document the result when no series has a value ({COUNT_DOC})."
    )


UNDOCUMENTED_FUNCTIONS: dict[str, str] = {
    "per_second": _rate_reason("per_second"),
    "per_minute": _rate_reason("per_minute"),
    "per_hour": _rate_reason("per_hour"),
    "diff": _diff_reason("diff"),
    "monotonic_diff": _diff_reason("monotonic_diff"),
    "default_zero": (
        "Function 'default_zero' is not supported: Datadog interpolates gaps first and then "
        f"fills the remaining intervals with 0 ({INTERPOLATION_DOC}); PromQL has no gap "
        "interpolation."
    ),
    "count_nonzero": _count_reason("count_nonzero"),
    "count_not_null": _count_reason("count_not_null"),
    "anomalies": (
        "Function 'anomalies' is not supported: Datadog's anomaly algorithms and bounds are not "
        f"documented precisely enough to reproduce in PromQL ({ANOMALY_DOC})."
    ),
}

_ANY_FUNCTION = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\(")


def function_block(text: str, anywhere: bool = False) -> tuple[str, str] | None:
    """(message, suggested action) for `top()` or a function with undocumented semantics.

    Query strings only block on a leading function; formulas pass ``anywhere=True``, since
    a function can appear inside arithmetic (``query1 * per_minute(query2)``)."""
    top = top_block(text)
    if top is not None:
        return top
    names = (
        _ANY_FUNCTION.findall(text)
        if anywhere
        else [m.group(1) for m in [_LEADING_FUNCTION.match(text)] if m]
    )
    for name in names:
        if name == "top":
            return TOP_MESSAGE, TOP_ACTION
        if name in UNDOCUMENTED_FUNCTIONS:
            return UNDOCUMENTED_FUNCTIONS[name], _UNDOCUMENTED_ACTION
    return None
