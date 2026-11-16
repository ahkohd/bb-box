import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { SelkiesBox, SelkiesRelay } from '../work/src/core/selkies.ts';
import { AgentShapes } from '../work/src/core/agent-shapes.ts';
const open = async () => {
 const socket=connect(5980,'127.0.0.1');
 await new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j)});
 const streams=Duplex.toWeb(socket);
 return {...streams,close:async()=>socket.destroy()};
};
const box=new SelkiesBox(open,{onError:console.error});
const viewers=new Set();
const tell=message=>{for(const ws of viewers)ws.send(message)};
const shapes=new AgentShapes({now:()=>Date.now()/1000,schedule:setTimeout,cancel:clearTimeout,send:(_,message)=>tell(message)});
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/act')){
 const p=new URL(req.url,'http://localhost').searchParams;
 const shape=p.get('shape');
 if(shape==='clear'){shapes.forget('box');tell('BB_AGENT,clear');await box.cursorInVideo(true,'selkies')}
 else {await box.cursorInVideo(false,'selkies');const x=Number(p.get('x')),y=Number(p.get('y'));tell(`BB_AGENT,click,${x},${y}`);shapes.acted('box',{act:'click',x,y,shape})}
 res.end('ok');return;
 }
 res.setHeader('Content-Type',req.url==='/viewer.js'?'text/javascript':'text/html');
 res.end(req.url==='/viewer.js'?await readFile(new URL('viewer.js',import.meta.url)):'<script type="module" src="/viewer.js"></script>');
});
const wss=new WebSocketServer({server});
wss.on('connection',ws=>{
 viewers.add(ws);
 const relay=new SelkiesRelay({box,open,mayInput:()=>false,viewer:{send:m=>ws.send(m),close:()=>ws.close()}});
 ws.on('message',(m,b)=>void relay.receive(b?new Uint8Array(m):m.toString()));
 ws.on('close',()=>{viewers.delete(ws);void relay.close()});
});
server.listen(8765,'127.0.0.1');
