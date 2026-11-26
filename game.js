(() => {
  const $ = id => document.getElementById(id);
  const authScreen = $("auth-screen"), gameScreen = $("game-screen");
  let mode = "login", token = localStorage.getItem("gf_token"), user = null;
  let socket = null, lastSave = 0, lastMoveEmit = 0, lastOxygenTick = 0, underwater = false;
  const canvas = $("game"), ctx = canvas.getContext("2d");
  const WORLD = { w: 3000, h: 1800 };
  const state = {
    x:480,y:360,health:100,oxygen:100,level:1,xp:0,credits:100,
    inventory:{iron:0,crystal:0,bio_sample:0,oxygen_tank:2},discovered:["VERDANT-01"]
  };
  const keys = {};
  const others = new Map();
  const resources = [];
  const rand = (a,b) => a + Math.random()*(b-a);
  for(let i=0;i<100;i++){
    resources.push({x:rand(80,WORLD.w-80),y:rand(80,WORLD.h-80),type:["iron","crystal","bio_sample"][i%3],taken:false});
  }
  const waterZones = [{x:1250,y:520,w:900,h:800},{x:300,y:1100,w:650,h:500}];
  const inWater = (x,y) => waterZones.some(z=>x>z.x&&x<z.x+z.w&&y>z.y&&y<z.y+z.h);
  function log(message){const el=$("log");el.textContent=`[${new Date().toLocaleTimeString()}] ${message}\n`+el.textContent;}
  function message(text,error=false){$("auth-message").textContent=text;$("auth-message").style.color=error?"#ffad9f":"#78e6bc";}
  async function api(path, body){
    const response=await fetch(path,{method:body?"POST":"GET",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
    const data=await response.json();if(!response.ok)throw new Error(data.error||"요청 실패");return data;
  }
  function setMode(next){mode=next;$("login-tab").classList.toggle("active",mode==="login");$("register-tab").classList.toggle("active",mode==="register");$("auth-submit").textContent=mode==="login"?"우주로 출발":"탐험가 등록";$("password").autocomplete=mode==="login"?"current-password":"new-password";message("");}
  $("login-tab").onclick=()=>setMode("login");$("register-tab").onclick=()=>setMode("register");
  $("auth-form").onsubmit=async e=>{
    e.preventDefault();$("auth-submit").disabled=true;
    try{
      const data=await api(mode==="login"?"/api/login":"/api/register",{username:$("username").value,password:$("password").value});
      token=data.token;localStorage.setItem("gf_token",token);user=data.user;loadCharacter(data.character);enterGame();
    }catch(err){message(err.message,true);}finally{$("auth-submit").disabled=false;}
  };
  function loadCharacter(c){Object.assign(state,c);state.inventory={iron:0,crystal:0,bio_sample:0,oxygen_tank:2,...c.inventory};}
  async function enterGame(){
    authScreen.classList.add("hidden");gameScreen.classList.remove("hidden");$("player-name").textContent=user.username;
    connectSocket();renderUI();log("개척선 착륙 완료. 탐험을 시작하세요.");
  }
  async function boot(){
    if(!token)return;
    try{const data=await api("/api/me");user=data.user;loadCharacter(data.character);enterGame();}
    catch{localStorage.removeItem("gf_token");token=null;}
  }
  function connectSocket(){
    socket=io({auth:{token}});
    socket.on("connect",()=>log("은하 통신망에 연결되었습니다."));
    socket.on("connect_error",()=>log("온라인 연결 실패: 싱글 탐험은 계속할 수 있습니다."));
    socket.on("world:players",players=>{others.clear();players.forEach(p=>others.set(p.id,p));updateOnline();});
    socket.on("world:join",p=>{others.set(p.id,p);updateOnline();log(`${p.username} 탐험가가 접속했습니다.`);});
    socket.on("player:moved",p=>others.set(p.id,p));
    socket.on("world:leave",id=>{others.delete(id);updateOnline();});
  }
  function updateOnline(){$("online-count").textContent=others.size+1;}
  async function saveGame(){
    if(!token)return;
    try{await fetch("/api/save",{method:"PUT",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(state)});$("save-status").textContent="저장 완료";}
    catch{$("save-status").textContent="저장 실패";}
  }
  function renderUI(){
    $("health-value").textContent=`${Math.round(state.health)} / 100`;$("health-bar").style.width=state.health+"%";
    $("oxygen-value").textContent=Math.round(state.oxygen)+"%";$("oxygen-bar").style.width=state.oxygen+"%";
    $("level-label").textContent="LV."+state.level;$("level-value").textContent=state.level;
    $("xp-value").textContent=`${state.xp} / ${state.level*100}`;$("credits-value").textContent=state.credits+" CR";
    $("iron-value").textContent=state.inventory.iron;$("crystal-value").textContent=state.inventory.crystal;
    $("bio-value").textContent=state.inventory.bio_sample;$("tank-value").textContent=state.inventory.oxygen_tank;
    $("discoveries").textContent=state.discovered.length;
    $("mission-text").textContent=underwater?"심해 자원을 탐색하세요. 산소가 부족하면 R 키를 누르세요.":"주변의 광물 노드를 찾아 E 키로 채집하세요.";
    $("zone-label").textContent=underwater?"PELAGIA-02 · 심해 구역":"VERDANT-01 · 생명 행성";
  }
  function toggleDive(){
    if(!inWater(state.x,state.y)){log("물속 구역에서만 잠수할 수 있습니다.");return;}
    underwater=!underwater;
    if(!underwater)state.oxygen=Math.max(state.oxygen,Math.min(100,state.oxygen+5));
    log(underwater?"잠수 시작. 산소를 확인하세요.":"수면으로 상승했습니다.");renderUI();saveGame();
  }
  function useTank(){
    if(state.inventory.oxygen_tank<=0){log("산소통이 없습니다.");return;}
    state.inventory.oxygen_tank--;state.oxygen=100;log("산소통을 사용했습니다.");renderUI();saveGame();
  }
  function gather(){
    let target=null,dist=55;
    for(const r of resources){if(r.taken)continue;const d=Math.hypot(r.x-state.x,r.y-state.y);if(d<dist){dist=d;target=r;}}
    if(!target){log("채집할 자원이 가까이에 없습니다.");return;}
    target.taken=true;state.inventory[target.type]++;state.xp+=15;state.credits+=5;
    if(state.xp>=state.level*100){state.xp-=state.level*100;state.level++;state.health=100;log(`레벨 업! 현재 레벨 ${state.level}`);}
    log(`${target.type==="iron"?"철광석":target.type==="crystal"?"에너지 수정":"생체 샘플"} 채집 완료.`);renderUI();saveGame();
  }
  window.addEventListener("keydown",e=>{
    const k=e.key.toLowerCase();if(["arrowup","arrowdown","arrowleft","arrowright"," "].includes(k))e.preventDefault();
    keys[k]=true;if(e.repeat)return;
    if(k==="e")gather();if(k===" ")toggleDive();if(k==="r")useTank();
  });
  window.addEventListener("keyup",e=>keys[e.key.toLowerCase()]=false);
  $("use-tank").onclick=useTank;
  $("logout").onclick=async()=>{await saveGame();if(socket)socket.disconnect();localStorage.removeItem("gf_token");token=null;location.reload();};
  function draw(){
    const camX=Math.max(0,Math.min(WORLD.w-canvas.width,state.x-canvas.width/2));
    const camY=Math.max(0,Math.min(WORLD.h-canvas.height,state.y-canvas.height/2));
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle=underwater?"#092e42":"#173a36";ctx.fillRect(0,0,canvas.width,canvas.height);
    // Subtle grid and terrain patches.
    for(let x=Math.floor(camX/80)*80;x<camX+canvas.width;x+=80)for(let y=Math.floor(camY/80)*80;y<camY+canvas.height;y+=80){
      ctx.fillStyle=((x/80+y/80)%2===0)?"#ffffff08":"#00000008";ctx.fillRect(x-camX,y-camY,80,80);
    }
    waterZones.forEach(z=>{ctx.fillStyle=underwater?"#087da066":"#168db044";ctx.fillRect(z.x-camX,z.y-camY,z.w,z.h);ctx.strokeStyle="#58d9ed99";ctx.strokeRect(z.x-camX,z.y-camY,z.w,z.h);});
    // Station
    ctx.fillStyle="#a9c8d9";ctx.fillRect(420-camX,300-camY,120,90);ctx.fillStyle="#5ce1e6";ctx.fillRect(440-camX,315-camY,80,12);ctx.fillStyle="#253d52";ctx.fillRect(465-camX,345-camY,30,45);
    ctx.fillStyle="#e6f7ff";ctx.font="12px sans-serif";ctx.fillText("OUTPOST",438-camX,288-camY);
    resources.forEach(r=>{if(r.taken)return;const x=r.x-camX,y=r.y-camY;if(x<-15||y<-15||x>canvas.width+15||y>canvas.height+15)return;ctx.beginPath();ctx.fillStyle=r.type==="iron"?"#c0c9d0":r.type==="crystal"?"#75e8ff":"#c4ed85";ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#ffffff66";ctx.stroke();});
    // Other explorers
    for(const p of others.values()){ctx.fillStyle="#f3b96d";ctx.beginPath();ctx.arc(p.x-camX,p.y-camY,9,0,Math.PI*2);ctx.fill();ctx.fillStyle="#fff";ctx.font="10px sans-serif";ctx.fillText(p.username,p.x-camX-20,p.y-camY-15);}
    // Player
    ctx.save();ctx.translate(state.x-camX,state.y-camY);ctx.fillStyle=underwater?"#5ce1e6":"#f3f7ff";ctx.beginPath();ctx.arc(0,0,11,0,Math.PI*2);ctx.fill();ctx.fillStyle="#24445a";ctx.fillRect(-5,-4,10,7);ctx.strokeStyle="#fff";ctx.strokeRect(-11,-11,22,22);ctx.restore();
    if(underwater){ctx.fillStyle="#061c2b55";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle="#c7f8ff";ctx.font="bold 15px sans-serif";ctx.fillText("UNDERWATER · PRESSURE ZONE",20,canvas.height-22);}
  }
  function loop(ts){
    const speed=underwater?1.8:3.2;let dx=0,dy=0;
    if(keys.w||keys.arrowup)dy--;if(keys.s||keys.arrowdown)dy++;if(keys.a||keys.arrowleft)dx--;if(keys.d||keys.arrowright)dx++;
    if(dx||dy){const len=Math.hypot(dx,dy);state.x=Math.max(24,Math.min(WORLD.w-24,state.x+dx/len*speed));state.y=Math.max(24,Math.min(WORLD.h-24,state.y+dy/len*speed));}
    if(underwater&&ts-lastOxygenTick>1000){lastOxygenTick=ts;state.oxygen=Math.max(0,state.oxygen-1.8);if(state.oxygen<=0){state.health=Math.max(1,state.health-4);if(state.health<=1){underwater=false;state.x=480;state.y=360;state.oxygen=35;log("산소 고갈! 구조 지점으로 후송되었습니다.");}}renderUI();}
    if(socket&&socket.connected&&ts-lastMoveEmit>100){lastMoveEmit=ts;socket.emit("player:move",{x:state.x,y:state.y});}
    if(ts-lastSave>15000){lastSave=ts;saveGame();}
    draw();requestAnimationFrame(loop);
  }
  window.addEventListener("beforeunload",()=>{if(token)saveGame();});
  boot();requestAnimationFrame(loop);
})();