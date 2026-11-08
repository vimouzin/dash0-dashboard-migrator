"""Bounded classic metric-monitor arithmetic, shared by compile and live checks.

Grammar: expression := term (("+" | "-") term)*; term := factor
(("*" | "/") factor)*; factor := metric_query | finite_number | "(" expression ")"
| ("+" | "-") factor. Every metric leaf is validated by the ordinary query parser.
Datadog documents that classic arithmetic is evaluated before time aggregation:
https://docs.datadoghq.com/monitors/guide/as-count-in-monitor-evaluations/.
Count-style evaluation has a different order and is rejected by the monitor compiler.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import NoReturn

from migrator.source.datadog.formula import Abs, Bin, Formula, Num, Ref
from migrator.source.datadog.model import (
    MetricQuery,
    MonitorExpression,
    ParseError,
    TagFilter,
)
from migrator.source.datadog.parse_query import parse_metric_query

_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_FUNCTION = re.compile(r"\.[A-Za-z_][A-Za-z0-9_]*\(")


@dataclass(frozen=True)
class ExpressionOk:
    expression: MonitorExpression


class _Fail(Exception):
    def __init__(self, error: ParseError) -> None:
        self.error = error


class _Parser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0
        self.queries: list[MetricQuery] = []
        self.depth = 0

    def fail(self, message: str) -> NoReturn:
        raise _Fail(
            ParseError(
                "UNSUPPORTED_QUERY_SYNTAX",
                len(self.text[: self.pos].encode("utf-16-le")) // 2,
                message,
            )
        )

    def peek(self) -> str:
        while self.pos < len(self.text) and self.text[self.pos] == " ":
            self.pos += 1
        return self.text[self.pos] if self.pos < len(self.text) else ""

    def expression(self) -> Formula:
        result = self.term()
        while self.peek() in ("+", "-"):
            op = self.text[self.pos]
            self.pos += 1
            result = Bin("+" if op == "+" else "-", result, self.term())
        return result

    def term(self) -> Formula:
        result = self.factor()
        while self.peek() in ("*", "/"):
            op = self.text[self.pos]
            self.pos += 1
            result = Bin("*" if op == "*" else "/", result, self.factor())
        return result

    def factor(self) -> Formula:
        self.depth += 1
        if self.depth > 64:
            self.fail("Monitor arithmetic nesting exceeds 64 levels.")
        try:
            ch = self.peek()
            if ch in ("+", "-"):
                self.pos += 1
                arg = self.factor()
                return arg if ch == "+" else Bin("-", Num("0"), arg)
            if ch == "(":
                self.pos += 1
                result = self.expression()
                if self.peek() != ")":
                    self.fail("Expected ')' in monitor arithmetic.")
                self.pos += 1
                return result
            number = _NUMBER.match(self.text, self.pos)
            if number is not None:
                self.pos = number.end()
                if not math.isfinite(float(number.group())):
                    self.fail("Monitor arithmetic constants must be finite.")
                return Num(number.group())
            return self.metric()
        finally:
            self.depth -= 1

    def metric(self) -> Ref:
        start = self.pos
        # Metric names/aggregators cannot contain these expression delimiters. Filters
        # are scanned separately so '-' and '/' inside a tag value remain literal.
        while self.pos < len(self.text) and self.text[self.pos] not in "{()+-*/ ":
            self.pos += 1
        if self.pos == len(self.text) or self.text[self.pos] != "{":
            self.fail("Expected a complete metric query in monitor arithmetic.")
        self.braces()
        if self.text.startswith(" by {", self.pos):
            self.pos += len(" by ")
            self.braces()
        while self.pos < len(self.text) and self.text[self.pos] == ".":
            func = _FUNCTION.match(self.text, self.pos)
            if func is None:
                self.fail("Expected a query function in monitor arithmetic.")
            self.pos = func.end()
            close = self.text.find(")", self.pos)
            if close < 0:
                self.fail("Unclosed query function in monitor arithmetic.")
            self.pos = close + 1
        parsed = parse_metric_query(self.text[start : self.pos])
        if not parsed.ok:
            raise _Fail(
                ParseError(
                    parsed.code,
                    len(self.text[:start].encode("utf-16-le")) // 2 + parsed.offset,
                    parsed.message,
                )
            )
        name = f"q{len(self.queries)}"
        self.queries.append(parsed.query)
        return Ref(name)

    def braces(self) -> None:
        close = self.text.find("}", self.pos + 1)
        if close < 0:
            self.fail("Unclosed filter or group in monitor arithmetic.")
        self.pos = close + 1


def parse_monitor_expression(text: str) -> ExpressionOk | ParseError:
    parser = _Parser(text)
    try:
        formula = parser.expression()
        if parser.peek():
            parser.fail("Unexpected trailing syntax in monitor arithmetic.")
        if not parser.queries:
            parser.fail("Monitor arithmetic must reference at least one metric query.")
    except _Fail as fail:
        return fail.error
    return ExpressionOk(MonitorExpression(tuple(parser.queries), formula))


def _filter_text(filt: TagFilter) -> str:
    # The parser only produces OR'd values for positive filters; NOT (a OR b) is split into
    # one negated filter per value.
    if filt.negated:
        return f"!{filt.key}:{filt.value}"
    text = " OR ".join(f"{filt.key}:{v}" for v in filt.values)
    return f"({text})" if filt.alternatives else text


def metric_query_text(query: MetricQuery) -> str:
    """Serialize this bounded query without changing its semantics or inventing labels."""
    prefix = f"{query.aggregator}:" if query.aggregator is not None else ""
    filters = (
        ",".join(
            _filter_text(filt) if isinstance(filt, TagFilter) else f"${filt.name}"
            for filt in query.filters
        )
        or "*"
    )
    text = f"{prefix}{query.metric}{{{filters}}}"
    if query.group_by:
        text += " by {" + ",".join(query.group_by) + "}"
    for func in query.functions:
        text += f".{func.name}({','.join(func.args)})"
    return text


def _source_formula(formula: Formula) -> str:
    if isinstance(formula, Ref):
        return formula.name
    if isinstance(formula, Num):
        return formula.value
    if isinstance(formula, Abs):
        return f"abs({_source_formula(formula.arg)})"
    return f"({_source_formula(formula.left)} {formula.op} {_source_formula(formula.right)})"


def monitor_source_queries(query: MetricQuery | MonitorExpression) -> tuple[list[str], str]:
    """Return independent source queries and q0/q1/... formula for empirical checks."""
    if isinstance(query, MetricQuery):
        return [metric_query_text(query)], "q0"
    return [metric_query_text(q) for q in query.queries], _source_formula(query.formula)
