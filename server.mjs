import {createServer} from 'node:http';
import {randomBytes, randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const engine = new Script(html.split('<script>')[1].split('</script>')[0] + `
globalThis.matchEngine = {
 start(){start(false)},
 tick(input,dt){
  now+=dt;keys.clear();
  for(const [i,bindings] of input.entries())for(const [j,code] of bindings.entries())if(code)keys.add(i===0?['KeyA','KeyD','KeyW','KeyJ'][j]:['ArrowLeft','ArrowRight','ArrowUp','KeyL'][j]);
  if(active)update(dt);else if(transition)advanceTransition(dt);
 },
 snapshot(){
  return {players,mobs,loot,shots,fx:fx.splice(0),elapsed,round,wins,safe,active,transition,
   complete:!active&&!transition,title:el('title').textContent,message:el('message').textContent,
   cues:audioEvents.splice(0)};
 }
};
`);
const noop = () => {};
function initMatch() {
  const nodes = new Map();
  const node = () => ({width:960,height:540,style:{},getContext:()=>({}),append:noop,replaceChildren:noop});
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id,node());
      return nodes.get(id);
    },
    createElement:node,
    querySelectorAll:()=>[]
  };
  const sandbox = createContext({document, authoritative:true, addEventListener:noop, requestAnimationFrame:noop});
  engine.runInContext(sandbox);
  sandbox.matchEngine.start();
  return sandbox.matchEngine;
}
const rooms = new Map();
const codes = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomLifetime = 30 * 60_000;
const disconnectLimit = 15_000;
const neutral = [false,false,false,false];
function seat() {
  return {token:randomBytes(24).toString('base64url'),ready:false,seen:Date.now(),input:neutral,pressed:[...neutral]};
}
function visible(room, index, after) {
  return {
    code:room.code,you:index,phase:room.phase,
    players:room.seats.map(p=>p?{ready:p.ready,connected:Date.now()-p.seen<4000}:null),
    game:room.game,result:room.result,
    events:room.events.filter(e=>e.id>after)
  };
}
function sendSocket(socket,message){
  if(socket?.readyState===1&&socket.bufferedAmount<65536)socket.send(JSON.stringify(message));
}
function publish(room){
  for(const [i,seat] of room.seats.entries()){
    if(seat?.socket?.readyState!==1||seat.socket.bufferedAmount>=65536)continue;
    const snapshot=visible(room,i,seat.after);
    sendSocket(seat.socket,{type:'state',data:snapshot});
    seat.after=snapshot.events.at(-1)?.id??seat.after;
  }
}
export function attachSocket(socket){
  let room, player,index;
  const authTimeout=setTimeout(()=>socket.close(1008,'Session required'),5000);
  authTimeout.unref?.();
  socket.on('error',noop);
  socket.on('close',()=>{
    clearTimeout(authTimeout);
    if(player?.socket===socket){player.socket=null;player.input=neutral;player.pressed=[...neutral];}
  });
  socket.on('message',raw=>{
    let message;
    try{message=JSON.parse(String(raw));}catch{return;}
    if(!message||typeof message!=='object')return;
    if(!player){
      if(message.type!=='hello')return socket.close(1008,'Session required');
      room=rooms.get(String(message.code??'').toUpperCase());
      index=room?.seats.findIndex(p=>p&&p.token===message.token)??-1;
      if(index<0)return socket.close(1008,'Invalid session');
      clearTimeout(authTimeout);
      player=room.seats[index];
      player.socket?.close(1000,'Reconnected');
      player.socket=socket;
      player.after=Math.min(room.eventId,Math.max(0,Number(message.after)||0));
      player.seen=room.updated=Date.now();
      publish(room);
      return;
    }
    if(player.socket!==socket)return;
    player.seen=room.updated=Date.now();
    if(message.type==='ping')sendSocket(socket,{type:'pong',sent:message.sent});
    if(message.type==='input'&&room.phase==='playing'&&Array.isArray(message.input)){
      const input=neutral.map((_,i)=>message.input[i]===true);
      player.pressed=player.pressed.map((held,i)=>held||(input[i]&&!player.input[i]));
      player.input=input;
    }
  });
}
function finish(room, result) {
  room.phase='finished';room.result=result;room.updated=Date.now();publish(room);
}
function leave(room,index) {
  if(room.phase==='playing') {
    finish(room, index===0?'居居侠退出或断线，小狗大王获胜。':'小狗大王退出或断线，居居侠获胜。');
  } else if(room.phase==='lobby'){
    if(index===0)finish(room,'房主已关闭房间。');
    else{room.seats[1]?.socket?.close(1000,'Left room');room.seats[1]=null;publish(room);}
  }
}
export function updateRooms() {
  const now=Date.now();
  for(const [code,room] of rooms){
    if(now-room.updated>roomLifetime){rooms.delete(code);continue;}
    if(room.phase==='lobby'){
      if(room.seats[0]&&now-room.seats[0].seen>disconnectLimit)leave(room,0);
      if(room.seats[1]&&now-room.seats[1].seen>disconnectLimit)leave(room,1);
      continue;
    }
    if(room.phase!=='playing')continue;
    const missing=room.seats.findIndex(p=>now-p.seen>disconnectLimit);
    if(missing>=0){leave(room,missing);continue;}
    const inputs=room.seats.map(p=>now-p.seen<3500?p.input.map((held,i)=>held||p.pressed[i]):neutral);
    for(const p of room.seats)p.pressed=[...neutral];
    room.engine.tick(inputs,1/60);
    const {fx,cues,...game}=room.engine.snapshot();
    if(fx.length||cues.length)room.events.push({id:++room.eventId,fx,cues,time:now});
    room.events=room.events.filter(event=>now-event.time<2000);
    room.game=game;
    if(game.complete)finish(room,game.title+' · '+game.message);
    else if(++room.pushTick%2===0)publish(room);
  }
}
function send(res,status,value){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}
async function body(req) {
  let raw='';
  for await(const chunk of req){
    raw+=chunk.toString();
    if(raw.length>2048)throw Error('请求太大');
  }
  return JSON.parse(raw||'{}');
}
export async function handleRequest(req,res){
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
      res.end(html);return;
    }
    if(req.method!=='POST'||url.pathname!=='/api/room')return send(res,404,{error:'找不到页面'});
    const request=await body(req);
    if(request.action==='create'){
      if(rooms.size>=100)return send(res,503,{error:'房间已满，请稍后再试'});
      let code;
      do{code=Array.from({length:6},()=>codes[randomInt(codes.length)]).join('')}while(rooms.has(code));
      const host=seat();
      const room={code,seats:[host,null],phase:'lobby',updated:Date.now(),events:[],eventId:0,pushTick:0,game:null,result:null};
      rooms.set(code,room);
      return send(res,200,{...visible(room,0,0),token:host.token});
    }
    const room=rooms.get(String(request.code??'').toUpperCase());
    if(!room)return send(res,404,{error:'房间不存在或已关闭'});
    if(request.action==='join'){
      if(room.phase!=='lobby'||room.seats[1])return send(res,409,{error:'房间已满或已开局'});
      const guest=seat();room.seats[1]=guest;room.updated=Date.now();publish(room);
      return send(res,200,{...visible(room,1,0),token:guest.token});
    }
    const index=room.seats.findIndex(p=>p&&p.token===request.token);
    if(index<0)return send(res,403,{error:'房间会话已失效'});
    const player=room.seats[index];
    player.seen=room.updated=Date.now();
    if(request.action==='ready'&&room.phase==='lobby'){
      player.ready=Boolean(request.ready);
      if(room.seats.every(p=>p?.ready)){
        room.engine=initMatch();
        room.game=room.engine.snapshot();room.phase='playing';
      }
      publish(room);
    }else if(request.action==='leave'){
      leave(room,index);
    }else if(request.action==='poll'){
      if(room.phase==='playing'&&Array.isArray(request.input))player.input=neutral.map((_,i)=>request.input[i]===true);
    }
    return send(res,200,visible(room,index,Number(request.after)||0));
  }catch(error){
    console.error(error.message);
    if(!res.headersSent)send(res,400,{error:'房间请求失败，请重试'});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  setInterval(updateRooms,1000/60).unref();
  const server=createServer(handleRequest);
  const {WebSocketServer}=require('ws');
  const sockets=new WebSocketServer({server,path:'/api/live',maxPayload:2048,perMessageDeflate:false});
  sockets.on('connection',attachSocket);
  server.listen(Number(process.env.PORT)||8080,'0.0.0.0',()=>console.log('动物对决好友房已启动'));
}
