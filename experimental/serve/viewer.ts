// The built-in live viewer for `dd2dash0 serve`. Self-contained HTML (no CDN), so the demo works offline.
// Henry's review console can replace it: everything it shows comes from /events and /report.json.
// Voice: the page calls window.ddVoice?.onEvent(event) for every event. The ElevenLabs module plugs in there.
export const VIEWER_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dd2dash0 live</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3de;
--exact:#1f7a4d;--under:#2f6fb0;--bounded:#a8670a;--manual:#b3261e;--unsupported:#6b4fa0}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#9a9a94;--card:#1e1e1c;--line:#2e2e2b;
--exact:#4cc38a;--under:#6ea8e8;--bounded:#e0a43c;--manual:#f07068;--unsupported:#b39ae8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{padding:16px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
h1{font-size:17px;margin:0}.muted{color:var(--muted)}
.bar{flex:1;min-width:220px;height:10px;background:var(--line);border-radius:5px;overflow:hidden;display:flex}
.bar span{display:block;height:100%}
main{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;padding:16px}
@media (max-width:860px){main{grid-template-columns:1fr}}
section.dash{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px}
section.dash h2{font-size:14px;margin:0 0 8px}
.items{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--line);border-radius:6px;padding:4px 8px;cursor:pointer;background:var(--card);max-width:100%;font:inherit;color:inherit;text-align:left;display:inline-flex;align-items:center;gap:6px}
.chip::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--c)}
.chip small{color:var(--muted)}
.s-exact{--c:var(--exact)}.s-exact-under{--c:var(--under)}.s-bounded{--c:var(--bounded)}.s-manual{--c:var(--manual)}.s-unsupported{--c:var(--unsupported)}
aside{display:flex;flex-direction:column;gap:12px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
#log{max-height:42vh;overflow:auto;font-size:13px}#log p{margin:0 0 6px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);padding:8px;border-radius:6px;font-size:12px}
.legend{display:flex;gap:10px;flex-wrap:wrap;font-size:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--c);margin-right:4px}
button.primary{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--fg);color:var(--bg);cursor:pointer}
</style></head><body>
<header><h1>dd2dash0: Datadog to Dash0, live</h1><span id="cov" class="muted">waiting for the run...</span>
<div class="bar" id="bar" aria-label="coverage"></div><button class="primary" id="replay">Replay</button></header>
<main><div id="dashboards"></div>
<aside><div class="panel"><div class="legend">
<span class="s-exact"><i></i>exact</span><span class="s-exact-under"><i></i>exact under assumptions</span><span class="s-bounded"><i></i>bounded error</span><span class="s-manual"><i></i>manual</span><span class="s-unsupported"><i></i>no Dash0 equivalent</span></div></div>
<div class="panel" id="voice"><strong>Narrator</strong> <button class="primary" id="voiceBtn" hidden>Start voice</button>
<div id="voiceStatus" class="muted">Voice off (no ElevenLabs agent configured).</div><div id="transcript" style="font-size:13px;margin-top:6px"></div></div>
<div class="panel"><strong>Run log</strong><div id="log"></div></div>
<div class="panel" id="detail"><strong>Item</strong><div class="muted">Click a widget to see the Datadog query next to the PromQL.</div></div>
</aside></main>
<script>
const $=s=>document.querySelector(s);const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const items=new Map();let es;
function section(name){const id="d-"+btoa(unescape(encodeURIComponent(name))).replace(/[^a-z0-9]/gi,"");let s=document.getElementById(id);
 if(!s){s=document.createElement("section");s.className="dash";s.id=id;s.innerHTML="<h2>"+esc(name)+"</h2><div class=items></div>";$("#dashboards").append(s)}return s.querySelector(".items")}
function log(t){if(!t)return;const p=document.createElement("p");p.textContent=t;$("#log").append(p);$("#log").scrollTop=1e9}
function show(e){$("#detail").innerHTML="<strong>"+esc(e.title)+"</strong> <span class='muted'>"+esc(e.widget_type)+" · "+esc(e.status)+"</span>"+
 "<p class=muted>Datadog</p><pre>"+esc(e.source_queries.join("\n")||"(none)")+"</pre><p class=muted>PromQL (Dash0)</p><pre>"+esc(e.promql.join("\n")||"(not translated)")+"</pre>"+
 (e.reason_codes.length?"<p class=muted>Why: "+esc(e.reason_codes.join(", "))+"</p>":"")+(e.manual_actions.length?"<p>"+esc(e.manual_actions.join(" "))+"</p>":"")}
function onEvent(e){
 if(e.type==="run.start"){$("#dashboards").innerHTML="";$("#log").innerHTML="";items.clear()}
 if(e.type==="item.done"){items.set(e.id,e);const b=document.createElement("button");b.className="chip s-"+e.status;b.innerHTML=esc(e.title)+" <small>"+esc(e.widget_type)+"</small>";b.onclick=()=>show(e);section(e.dashboard||"Monitors → check rules").append(b)}
 if(e.type==="run.done"){const t=Math.floor(e.coverageTranslated*1000)/10,x=Math.floor(e.coverageExact*1000)/10;
  $("#cov").textContent=t+"% translated · "+x+"% exact or exact-under (query panels)";
  $("#bar").innerHTML="<span style='width:"+x+"%;background:var(--exact)'></span><span style='width:"+(t-x)+"%;background:var(--bounded)'></span>"}
 log(e.say);if(window.ddVoice&&window.ddVoice.onEvent)window.ddVoice.onEvent(e)}
async function start(){const cfg=await (await fetch("/config.json")).json();window.ddConfig=cfg;if(es)es.close();
 es=new EventSource("/events");es.onmessage=m=>onEvent(JSON.parse(m.data));es.addEventListener("end",()=>es.close())}
$("#replay").onclick=start;start();

// ---- ElevenLabs voice narrator (optional) ----
// Every event goes to the agent as silent context (sendContextualUpdate). Milestones (a dashboard finished,
// something not migrated, the final verdict) become "[EVENT] ..." user messages so it speaks, throttled and
// never while it is already speaking. You can interrupt and ask questions; its tools read the real report.
(async()=>{const cfg=await (await fetch("/config.json")).json();if(!cfg.voice)return;
 const btn=$("#voiceBtn");btn.hidden=false;$("#voiceStatus").textContent="Voice ready. Click Start voice (uses your microphone).";
 let conv=null,mode="listening",queue=[],last=0;
 const say=t=>{const p=document.createElement("p");p.textContent=t;$("#transcript").append(p)};
 function pump(){if(!conv||mode==="speaking"||!queue.length||Date.now()-last<6000)return;
  const batch=queue.splice(0,queue.length);last=Date.now();
  conv.sendUserMessage("[EVENT] "+batch.slice(-2).join(" "))}
 setInterval(pump,1000);
 window.ddVoice={onEvent(e){if(!conv)return;conv.sendContextualUpdate(JSON.stringify({type:e.type,title:e.title,status:e.status,reasons:e.reason_codes,say:e.say}));
  const milestone=e.type==="dashboard.done"||e.type==="run.done"||e.type==="import.done"||(e.type==="item.done"&&(e.status==="manual"||e.status==="unsupported"));
  if(milestone&&e.say){if(e.type==="run.done")queue.length=0;queue.push(e.say)}}};
 btn.onclick=async()=>{btn.disabled=true;$("#voiceStatus").textContent="Connecting...";
  try{await navigator.mediaDevices.getUserMedia({audio:true});
   if(!window.ElevenLabsClient){await new Promise((ok,err)=>{const s=document.createElement("script");s.src="/vendor/elevenlabs.js";s.onload=ok;s.onerror=err;document.head.append(s)})}
   const {token}=await (await fetch("/api/el-token")).json();if(!token)throw new Error("no conversation token");
   conv=await ElevenLabsClient.Conversation.startSession({conversationToken:token,connectionType:"webrtc",
    clientTools:{
     get_summary:async()=>JSON.stringify(await (await fetch("/api/summary")).json()),
     get_item_details:async({query})=>JSON.stringify(await (await fetch("/api/item?q="+encodeURIComponent(query||""))).json())},
    onModeChange:({mode:m})=>{mode=m;$("#voiceStatus").textContent="Narrator is "+m+"."},
    onMessage:m=>{if(m&&m.message)say((m.source==="user"?"You: ":"Agent: ")+m.message)},
    onError:m=>{$("#voiceStatus").textContent="Voice error: "+m},
    onDisconnect:()=>{conv=null;btn.disabled=false;$("#voiceStatus").textContent="Voice disconnected."}});
   $("#voiceStatus").textContent="Narrator connected. Replaying the run...";start();
  }catch(err){btn.disabled=false;$("#voiceStatus").textContent="Could not start voice: "+err.message}}})();
</script></body></html>`;
