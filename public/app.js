const $ = s => document.querySelector(s);
const state = {
  ws:null,
  session:null,
  requests:[],
  console:[],
  html:"",
  storage:{local:{},session:{},cookies:[]},
  pageInfo:{title:"",url:""},
  paused:false,
  selected:null,
  tab:"network"
};

function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),1800)}
function setStatus(on,text){$("#dot").classList.toggle("on",on);$("#status").textContent=text}

async function connect(){
  const url=$("#url").value.trim();
  if(!/^https?:\/\//i.test(url)) return toast("URL harus diawali http:// atau https://");

  // If a session already exists, reuse it and navigate instead of creating
  // another browser session.
  if(state.ws && state.ws.readyState===1 && state.session){
    command("navigate",{url});
    return;
  }

  setStatus(false,"Connecting…");
  state.requests=[];
  state.selected=null;
  $("#detailEmpty").classList.remove("hidden");
  $("#detailContent").classList.add("hidden");
  renderNetwork();

  try {
    const r=await fetch("/api/session",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({url})
    });
    const data=await r.json();
    if(!r.ok) throw new Error(data.error||"Session gagal");

    state.session=data.id;
    const proto=location.protocol==="https:"?"wss":"ws";
    state.ws=new WebSocket(`${proto}://${location.host}${data.wsPath}`);

    state.ws.onopen=()=>{
      setStatus(true,"Connected");
      state.ws.send(JSON.stringify({type:"start",url:data.url||url}));
    };
    state.ws.onmessage=e=>{
      try { handle(JSON.parse(e.data)); }
      catch { toast("Pesan server tidak valid"); }
    };
    state.ws.onerror=()=>{
      setStatus(false,"Connection error");
      toast("WebSocket error");
    };
    state.ws.onclose=()=>{
      if(state.ws && state.ws.readyState!==1) setStatus(false,"Disconnected");
      state.ws=null;
      state.session=null;
    };
  } catch(e) {
    setStatus(false,"Disconnected");
    toast(e.message||"Gagal membuat session");
  }
}
function handle(msg){
  if(msg.event==="ready"){setStatus(true,"Live");$("#origin").textContent=msg.data.url;state.pageInfo={...state.pageInfo,...msg.data};updateInfo(state.pageInfo);command("html");command("storage")}
  if(msg.event==="attached"){setStatus(true,"Live")}
  if(msg.event==="navigation"){$("#url").value=msg.data.url;$("#origin").textContent=msg.data.url;state.pageInfo.url=msg.data.url;updateInfo(state.pageInfo);command("html");command("storage")}
  if(msg.event==="network"){upsertRequest(msg.data);if(!state.paused)renderNetwork()}
  if(msg.event==="console"){addConsole(msg.data)}
  if(msg.event==="html"){state.html=msg.data||"";$("#htmlBody").textContent=state.html}
  if(msg.event==="storage"){state.storage=msg.data||{local:{},session:{},cookies:[]};$("#storageBody").innerHTML=storageHtml(state.storage)}
  if(msg.event==="error"){toast(msg.message||"Error");addConsole({type:"error",text:msg.message||"Error"})}
}

function upsertRequest(d){
  const i=state.requests.findIndex(x=>x.id===d.id);
  if(i>=0) state.requests[i]={...state.requests[i],...d}; else state.requests.push(d);
  $("#networkCount").textContent=state.requests.length;
  $("#summary").textContent=`${state.requests.length} requests`;
  renderNetwork();
  if(state.selected?.id===d.id) showDetail(state.requests.find(x=>x.id===d.id));
}

function renderNetwork(){
  const q=$("#filter").value.toLowerCase();
  const rows=state.requests.filter(x=>`${x.method} ${x.status||""} ${x.type} ${x.url}`.toLowerCase().includes(q));
  $("#networkBody").innerHTML=rows.map(x=>`<tr data-id="${esc(x.id)}">
    <td class="${x.status>=200&&x.status<400?"ok":x.status?"bad":""}">${x.status||"—"}</td>
    <td class="method">${esc(x.method)}</td><td class="type">${esc(x.type)}</td>
    <td class="urlcell" title="${esc(x.url)}">${esc(x.url)}</td>
    <td>${x.size!=null?formatBytes(x.size):"—"}</td><td>${x.duration!=null?x.duration+" ms":"…"}</td>
  </tr>`).join("") || `<tr><td colspan="6"><div class="empty">No requests yet.</div></td></tr>`;
  document.querySelectorAll("#networkBody tr[data-id]").forEach(tr=>tr.onclick=()=>showDetail(state.requests.find(x=>x.id===tr.dataset.id)));
}

function showDetail(x){
  if(!x)return;
  state.selected=x;$("#detailEmpty").classList.add("hidden");$("#detailContent").classList.remove("hidden");
  $("#detailUrl").textContent=x.url;
  $("#detailMeta").innerHTML=`<div><label>Status</label><b class="${x.status>=200&&x.status<400?"ok":"bad"}">${x.status||"Pending"}</b></div>
  <div><label>Method</label><b>${esc(x.method)}</b></div><div><label>Type</label><b>${esc(x.type)}</b></div>
  <div><label>Duration</label><b>${x.duration??"—"} ${x.duration!=null?"ms":""}</b></div>`;
  $("#reqHeaders").textContent=pretty(x.requestHeaders);$("#reqBody").textContent=x.postData||"—";
  $("#resHeaders").textContent=pretty(x.responseHeaders);$("#resBody").textContent=formatBody(x.responseBody);
}
function pretty(v){try{return JSON.stringify(v||{},null,2)}catch{return String(v||"")}}
function formatBody(v){if(!v)return "—";try{return JSON.stringify(JSON.parse(v),null,2)}catch{return v}}
function formatBytes(n){if(n<1024)return n+" B";if(n<1048576)return (n/1024).toFixed(1)+" KB";return (n/1048576).toFixed(1)+" MB"}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}

function addConsole(d){
  $("#consoleCount").textContent=Number($("#consoleCount").textContent||0)+1;
  const entry={...d,time:new Date().toISOString()};
  state.console.push(entry);
  const row=document.createElement("div");row.className=`log ${d.type==="error"?"error":d.type==="warning"?"warn":""}`;
  row.innerHTML=`<span class="time">${new Date().toLocaleTimeString()}</span>${esc(d.text)}`;
  $("#consoleBody").appendChild(row);$("#consoleBody").scrollTop=$("#consoleBody").scrollHeight;
}
function storageHtml(d){
 return `<h3>LOCAL STORAGE</h3><pre>${esc(pretty(d.local))}</pre><h3>SESSION STORAGE</h3><pre>${esc(pretty(d.session))}</pre><h3>COOKIES</h3><pre>${esc(pretty(d.cookies))}</pre>`;
}
function updateInfo(d){
  $("#infoBody").innerHTML=`<div class="info-card"><label>Title</label><div>${esc(d.title||"")}</div></div><div class="info-card"><label>URL</label><div>${esc(d.url||"")}</div></div>`
}

function downloadJSON(filename, data){
  try {
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast(`Downloaded ${filename}`);
  } catch(e) { toast("Gagal membuat file JSON"); }
}

function currentPageHost(){
  try{return new URL(state.pageInfo.url||$("#url").value).hostname||"page"}
  catch{return "page"}
}

function buildFullExport(){
  return {
    schema:"fx-web-inspector.full.v2",
    exportedAt:new Date().toISOString(),
    tool:{name:"FX Web Inspector",version:"1.0"},
    page:{...state.pageInfo},
    summary:{
      networkRequests:state.requests.length,
      consoleMessages:state.console.length,
      htmlCaptured:!!state.html,
      localStorageKeys:Object.keys(state.storage?.local||{}).length,
      sessionStorageKeys:Object.keys(state.storage?.session||{}).length,
      cookies:Array.isArray(state.storage?.cookies)?state.storage.cookies.length:0,
      selectedRequestId:state.selected?.id||null
    },
    network:{
      total:state.requests.length,
      requests:state.requests.map(x=>({...x}))
    },
    console:state.console.map(x=>({...x})),
    elements:{html:state.html||""},
    storage:{
      local:{...(state.storage?.local||{})},
      session:{...(state.storage?.session||{})},
      cookies:Array.isArray(state.storage?.cookies)?state.storage.cookies.map(x=>({...x})):[]
    },
    selectedRequest:state.selected?{...state.selected}:null,
    inspector:{activeTab:state.tab,paused:state.paused,filter:$("#filter").value||""}
  };
}

function exportAll(){
  const data=buildFullExport();
  downloadJSON(`fx-web-inspector-full-${currentPageHost()}-${Date.now()}.json`,data);
}

function exportNetwork(){ exportAll(); }

function command(type,payload={}){
 if(!state.ws||state.ws.readyState!==1)return toast("Belum terhubung");
 state.ws.send(JSON.stringify({type,...payload}));
}
document.querySelectorAll(".nav").forEach(btn=>btn.onclick=()=>{
 document.querySelectorAll(".nav").forEach(x=>x.classList.remove("active"));btn.classList.add("active");
 const t=btn.dataset.tab;state.tab=t;
 ["network","console","elements","storage","info"].forEach(x=>$("#"+x+"Tab").classList.toggle("hidden",x!==t));
 const names={network:["Network","Live request / response monitor"],console:["Console","Browser console messages"],elements:["Elements","DOM snapshot"],storage:["Storage","Local/session storage and cookies"],info:["Page Info","Current page metadata"]};
 $("#panelTitle").textContent=names[t][0];$("#panelSub").textContent=names[t][1];
 if(t==="elements")command("html");if(t==="storage")command("storage");
});
$("#open").onclick=connect;
$("#url").onkeydown=e=>{if(e.key==="Enter")connect()};
$("#reload").onclick=()=>command("reload");
$("#filter").oninput=renderNetwork;
$("#pause").onclick=()=>{state.paused=!state.paused;$("#pause").textContent=state.paused?"Resume":"Pause"};
$("#clear").onclick=()=>{state.requests=[];state.console=[];$("#networkCount").textContent="0";$("#summary").textContent="0 requests";$("#consoleBody").innerHTML="";$("#consoleCount").textContent="0";renderNetwork();toast("Cleared")};
$("#copyAll").onclick=async()=>{
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.requests,null,2));
    toast("Network JSON copied");
  } catch {
    toast("Clipboard tidak tersedia");
  }
};
$("#closeDetail").onclick=()=>{$("#detailEmpty").classList.remove("hidden");$("#detailContent").classList.add("hidden")};
$("#downloadAll").onclick=exportAll;
$("#downloadNetwork").onclick=exportAll;
$("#downloadSelected").onclick=()=>{
  if(!state.selected)return toast("Pilih request terlebih dahulu");
  downloadJSON(`fx-request-${state.selected.id}.json`,{exportedAt:new Date().toISOString(),page:state.pageInfo,request:state.selected});
};
$("#back").onclick=()=>command("back");
$("#forward").onclick=()=>command("forward");

renderNetwork();setStatus(false,"Disconnected");