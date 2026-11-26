const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const MIN_PLAYERS = 3, MAX_PLAYERS = 10, MIN_ROUNDS = 5, MAX_ROUNDS = 30;
const CLUE_SECONDS = 45, GRACE_MS = 20000, EMPTY_ROOM_MS = 10 * 60 * 1000;
const WORD_PAIRS = [
  ["PIZZA","BURGER","Food"],["BEACH","POOL","Places"],["FOOTBALL","BASKETBALL","Sports"],
  ["CAT","DOG","Animals"],["AIRPLANE","HELICOPTER","Transport"],["COFFEE","TEA","Drinks"],
  ["GUITAR","PIANO","Music"],["SUN","MOON","Space"],["MOVIE","TV SHOW","Entertainment"],
  ["SCHOOL","COLLEGE","Places"],["RAIN","SNOW","Weather"],["TIGER","LION","Animals"],
  ["INSTAGRAM","SNAPCHAT","Technology"],["DOCTOR","NURSE","Jobs"],["CHESS","LUDO","Games"],
  ["MOUNTAIN","VOLCANO","Nature"],["CRICKET","TENNIS","Sports"],["CAKE","ICE CREAM","Food"],
  ["TRAIN","BUS","Transport"],["BATMAN","SPIDERMAN","Characters"]
];
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const connectedPlayers = r => [...r.players.values()].filter(p => p.connected);
const leaderboard = r => [...r.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score, connected:p.connected }))
  .sort((a,b) => b.score-a.score || a.name.localeCompare(b.name));
function publicRoom(r) {
  return {
    code:r.code, hostId:r.hostId, phase:r.phase, round:r.round, totalRounds:r.totalRounds,
    players:leaderboard(r), leaderboard:leaderboard(r), maxPlayers:MAX_PLAYERS,
    playersCount:r.players.size, clues:r.clues.map(c => ({name:r.players.get(c.playerId)?.name || "Player", text:c.text})),
    currentTurnName:r.turnOrder[r.turnIndex] ? r.players.get(r.turnOrder[r.turnIndex])?.name : null,
    timeLeft:r.timeLeft || 0, votesCast:r.votes.size, voteRound:r.voteRound || 1,
    revoteTargets:(r.phase === "revote" ? r.revoteTargets.map(id => ({id,name:r.players.get(id)?.name || "Player"})) : []),
    lastResult:r.lastResult || null
  };
}
function sendRoom(r) { io.to(r.code).emit("room:update", publicRoom(r)); }
function tellPlayer(id,event,data) { io.to(id).emit(event,data); }
function clearTimer(r) { if (r.timer) clearInterval(r.timer); r.timer = null; if (r.turnTimer) clearTimeout(r.turnTimer); r.turnTimer = null; }
function broadcastPrivateWords(r) {
  for (const p of r.players.values()) tellPlayer(p.id,"game:secret",{
    word:p.id===r.imposterId?r.imposterWord:r.mainWord,isImposter:p.id===r.imposterId,round:r.round
  });
}
function beginRound(r) {
  clearTimer(r);
  const players = connectedPlayers(r);
  if (players.length < MIN_PLAYERS) { r.phase="lobby"; sendRoom(r); return; }
  r.phase="secret"; r.clues=[]; r.votes=new Map(); r.voteRound=1; r.revoteTargets=[];
  r.turnOrder=players.map(p=>p.id).sort(()=>Math.random()-.5); r.turnIndex=0;
  const pair=WORD_PAIRS[Math.floor(Math.random()*WORD_PAIRS.length)];
  r.mainWord=pair[0]; r.imposterWord=pair[1]; r.category=pair[2];
  r.imposterId=players[Math.floor(Math.random()*players.length)].id;
  broadcastPrivateWords(r); r.phase="clues"; sendRoom(r); promptCurrentPlayer(r);
}
function promptCurrentPlayer(r) {
  if (r.turnIndex >= r.turnOrder.length) {
    r.phase="discussion"; r.timeLeft=60; sendRoom(r);
    io.to(r.code).emit("game:notice","Clue round complete. Discuss who you think the imposter is!");
    clearTimer(r); r.timer=setInterval(()=>{
      if (!rooms.has(r.code)||r.phase!=="discussion") return clearTimer(r);
      r.timeLeft--; sendRoom(r); if(r.timeLeft<=0) startVoting(r);
    },1000); return;
  }
  const p=r.players.get(r.turnOrder[r.turnIndex]);
  if(r.turnTimer) clearTimeout(r.turnTimer); r.turnTimer=null;
  if(!p) { r.turnIndex++; return promptCurrentPlayer(r); }
  io.to(r.code).emit("game:turn",{playerId:p.id,playerName:p.name,index:r.turnIndex+1,total:r.turnOrder.length});
  const pid=p.id, idx=r.turnIndex;
  r.turnTimer=setTimeout(()=>{
    if(!rooms.has(r.code)||r.phase!=="clues"||r.turnIndex!==idx||r.turnOrder[idx]!==pid) return;
    r.clues.push({playerId:pid,text:"(skipped)"}); r.turnIndex++; promptCurrentPlayer(r);
  },CLUE_SECONDS*1000);
  sendRoom(r);
}
function startVoting(r, revote=false) {
  clearTimer(r); r.phase=revote?"revote":"voting"; r.votes=new Map(); r.timeLeft=30;
  sendRoom(r); io.to(r.code).emit("game:notice",revote?"Revote: choose only between the tied players.":"Voting is open. Choose who you think the imposter is.");
  r.timer=setInterval(()=>{
    if(!rooms.has(r.code)||!(["voting","revote"].includes(r.phase))) return clearTimer(r);
    r.timeLeft--; sendRoom(r); if(r.timeLeft<=0) resolveVote(r);
  },1000);
}
function finishWithOutcome(r,caught,counts,reason) {
  clearTimer(r);
  if(caught) {
    for(const [voter,target] of r.votes.entries()) if(target===r.imposterId && r.players.has(voter)) r.players.get(voter).score+=2;
    const imp=r.players.get(r.imposterId); if(imp) imp.score-=1;
    r.phase="imposter_guess"; r.lastVoteCounts=counts; r.lastReason=reason;
    tellPlayer(r.imposterId,"game:lastChance",{prompt:"You were caught! Guess the majority word for +1 point."});
    io.to(r.code).emit("game:notice","The imposter was caught. They get one final chance to guess the majority word for +1 point.");
    r.timeLeft=20;
    sendRoom(r);
    r.timer=setInterval(()=>{
      if(!rooms.has(r.code)||r.phase!=="imposter_guess") return clearTimer(r);
      r.timeLeft--; sendRoom(r);
      if(r.timeLeft<=0) revealRound(r,true,r.lastVoteCounts,r.lastReason,false);
    },1000);
  } else {
    // An imposter who escapes earns no extra points; correct-vote points are only awarded on a successful catch.
    revealRound(r,false,counts,reason,false);
  }
}
function resolveVote(r) {
  clearTimer(r);
  if(!["voting","revote"].includes(r.phase)) return;
  const counts={}; for(const target of r.votes.values()) counts[target]=(counts[target]||0)+1;
  const max=Math.max(0,...Object.values(counts));
  const leaders=Object.keys(counts).filter(id=>counts[id]===max&&max>0);
  if(leaders.length===0) return revealRound(r,false,counts,"no_votes",false);
  if(leaders.length===1) return finishWithOutcome(r,leaders[0]===r.imposterId,counts,r.phase);
  if(r.phase==="voting" && leaders.length>1) {
    r.revoteTargets=leaders; r.voteRound=2; io.to(r.code).emit("game:notice","It's a tie! A revote will decide between the tied players.");
    return startVoting(r,true);
  }
  revealRound(r,false,counts,"tie",false);
}
function revealRound(r,caught,counts,reason,guessed) {
  clearTimer(r); r.phase="results";
  r.lastResult={imposterName:r.players.get(r.imposterId)?.name||"Unknown",mainWord:r.mainWord,
    imposterWord:r.imposterWord,caught,guessed,reason,
    voteCounts:Object.entries(counts||{}).map(([id,count])=>({name:r.players.get(id)?.name||"Player",count})),
    leaderboard:leaderboard(r)};
  io.to(r.code).emit("game:result",r.lastResult); sendRoom(r);
}
function resetMatch(r) {
  clearTimer(r); r.players.forEach(p=>p.score=0); r.round=0; r.phase="lobby"; r.clues=[]; r.votes=new Map();
  r.lastResult=null; r.imposterId=null; r.mainWord=null; r.imposterWord=null; r.revoteTargets=[]; r.voteRound=1;
}
const newToken = () => crypto.randomBytes(16).toString("hex");
function uniqueName(r,name) {
  const taken = new Set([...r.players.values()].map(p => p.name.toLowerCase()));
  let n = name, i = 2;
  while (taken.has(n.toLowerCase())) n = `${name.slice(0,14)} ${i++}`;
  return n;
}
function touchRoom(r) { if (r.cleanup) clearTimeout(r.cleanup); r.cleanup = null; }
function scheduleCleanup(r) {
  if (r.cleanup) clearTimeout(r.cleanup);
  r.cleanup = setTimeout(() => {
    if (rooms.get(r.code) === r && connectedPlayers(r).length === 0) { clearTimer(r); rooms.delete(r.code); }
  }, EMPTY_ROOM_MS);
}
const connectedVotes = r => [...r.votes.keys()].filter(id => r.players.get(id)?.connected).length;
// A reconnecting phone gets a new socket id; move the player's old id to the new one everywhere.
function migratePlayer(r,oldId,newId) {
  if (oldId === newId) return;
  const p = r.players.get(oldId); if (!p) return;
  r.players.delete(oldId); p.id = newId; r.players.set(newId,p);
  if (r.hostId === oldId) r.hostId = newId;
  if (r.imposterId === oldId) r.imposterId = newId;
  r.turnOrder = r.turnOrder.map(id => id === oldId ? newId : id);
  r.revoteTargets = r.revoteTargets.map(id => id === oldId ? newId : id);
  r.clues.forEach(c => { if (c.playerId === oldId) c.playerId = newId; });
  const nv = new Map(); for (const [v,t] of r.votes) nv.set(v === oldId ? newId : v, t === oldId ? newId : t); r.votes = nv;
  if (r.lastVoteCounts) { const c = {}; for (const [k,v] of Object.entries(r.lastVoteCounts)) c[k === oldId ? newId : k] = v; r.lastVoteCounts = c; }
}
// Runs when a player has been gone longer than the grace period.
function handleAbsence(r,p) {
  p.dropTimer = null;
  if (!rooms.has(r.code) || p.connected || r.players.get(p.id) !== p) return;
  if (r.hostId === p.id) { const next = connectedPlayers(r).find(x => x.id !== p.id); if (next) r.hostId = next.id; }
  if (r.phase === "lobby") r.players.delete(p.id);
  else if (r.phase === "clues" && r.turnOrder[r.turnIndex] === p.id) { r.clues.push({playerId:p.id,text:"(skipped)"}); r.turnIndex++; promptCurrentPlayer(r); }
  else if (["voting","revote"].includes(r.phase) && connectedPlayers(r).length > 0 && connectedVotes(r) >= connectedPlayers(r).length) resolveVote(r);
  sendRoom(r);
  if (connectedPlayers(r).length === 0) scheduleCleanup(r);
}
io.on("connection",socket=>{
  socket.on("room:create",({name,totalRounds},cb)=>{
    name=String(name||"Player").trim().slice(0,18)||"Player";
    const rounds=Math.max(MIN_ROUNDS,Math.min(MAX_ROUNDS,Number.parseInt(totalRounds,10)||5));
    let code; do{code=makeCode();}while(rooms.has(code));
    const token=newToken(); const player={id:socket.id,name,score:0,connected:true,token};
    const room={code,hostId:socket.id,players:new Map([[socket.id,player]]),phase:"lobby",round:0,totalRounds:rounds,
      clues:[],votes:new Map(),turnOrder:[],turnIndex:0,timeLeft:0,timer:null,revoteTargets:[],voteRound:1};
    rooms.set(code,room); socket.join(code); cb?.({ok:true,code,token}); sendRoom(room);
  });
  socket.on("room:join",({code,name},cb)=>{
    code=String(code||"").trim().toUpperCase(); name=String(name||"Player").trim().slice(0,18)||"Player";
    const r=rooms.get(code); if(!r)return cb?.({ok:false,error:"Room not found."});
    if(r.phase!=="lobby"&&r.phase!=="matchover")return cb?.({ok:false,error:"This game is already in progress."});
    if(r.players.size>=MAX_PLAYERS)return cb?.({ok:false,error:`Room is full. Maximum ${MAX_PLAYERS} players allowed.`});
    touchRoom(r); const token=newToken(); const player={id:socket.id,name:uniqueName(r,name),score:0,connected:true,token}; r.players.set(socket.id,player); socket.join(code);
    cb?.({ok:true,code,token}); sendRoom(r);
  });
  socket.on("room:rejoin",({code,token}={},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r)return cb?.({ok:false,error:"Room not found."});
    const p=[...r.players.values()].find(x=>x.token&&x.token===String(token||"")); if(!p)return cb?.({ok:false,error:"Player not found in this room."});
    if(p.dropTimer){clearTimeout(p.dropTimer);p.dropTimer=null;}
    touchRoom(r); migratePlayer(r,p.id,socket.id); p.connected=true; socket.join(r.code);
    if(r.mainWord&&["clues","discussion","voting","revote","imposter_guess","results"].includes(r.phase))
      tellPlayer(socket.id,"game:secret",{word:socket.id===r.imposterId?r.imposterWord:r.mainWord,isImposter:socket.id===r.imposterId,round:r.round});
    if(r.phase==="clues"){const cp=r.players.get(r.turnOrder[r.turnIndex]); if(cp)tellPlayer(socket.id,"game:turn",{playerId:cp.id,playerName:cp.name,index:r.turnIndex+1,total:r.turnOrder.length});}
    if(r.phase==="imposter_guess"&&socket.id===r.imposterId)tellPlayer(socket.id,"game:lastChance",{prompt:"You were caught! Guess the majority word for +1 point."});
    cb?.({ok:true,code:r.code,phase:r.phase,hasVoted:r.votes.has(socket.id)}); sendRoom(r);
  });
  socket.on("game:setRounds",({code,totalRounds},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r)return cb?.({ok:false,error:"Room not found."});
    if(socket.id!==r.hostId)return cb?.({ok:false,error:"Only the host can change match settings."});
    if(r.phase!=="lobby")return cb?.({ok:false,error:"Rounds can only be changed in the lobby."});
    const n=Number.parseInt(totalRounds,10); if(!Number.isFinite(n)||n<MIN_ROUNDS||n>MAX_ROUNDS)return cb?.({ok:false,error:`Choose between ${MIN_ROUNDS} and ${MAX_ROUNDS} rounds.`});
    r.totalRounds=n; cb?.({ok:true}); sendRoom(r);
  });
  socket.on("game:start",({code},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r)return cb?.({ok:false,error:"Room not found."});
    if(socket.id!==r.hostId)return cb?.({ok:false,error:"Only the host can start."});
    if(r.phase!=="lobby")return cb?.({ok:false,error:"A match is already running."});
    if(connectedPlayers(r).length<MIN_PLAYERS)return cb?.({ok:false,error:"At least 3 players are needed."});
    r.round=1; r.lastResult=null; cb?.({ok:true}); beginRound(r);
  });
  socket.on("game:clue",({code,text},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r||r.phase!=="clues")return cb?.({ok:false,error:"Clue round is not active."});
    if(r.turnOrder[r.turnIndex]!==socket.id)return cb?.({ok:false,error:"Wait for your turn."});
    text=String(text||"").trim().slice(0,40); if(!text)return cb?.({ok:false,error:"Enter a clue first."});
    r.clues.push({playerId:socket.id,text}); r.turnIndex++; cb?.({ok:true}); promptCurrentPlayer(r);
  });
  socket.on("chat:send",({code,text},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r||!["lobby","discussion","results","matchover"].includes(r.phase))return cb?.({ok:false,error:"Chat is unavailable right now."});
    text=String(text||"").trim().slice(0,300); if(!text)return cb?.({ok:false,error:"Message cannot be empty."});
    const p=r.players.get(socket.id); if(!p)return cb?.({ok:false,error:"You are not in this room."});
    io.to(r.code).emit("chat:message",{name:p.name,text,time:Date.now()}); cb?.({ok:true});
  });
  socket.on("game:vote",({code,targetId},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r||!["voting","revote"].includes(r.phase))return cb?.({ok:false,error:"Voting is not active."});
    if(!r.players.has(socket.id)||socket.id===targetId||!r.players.has(targetId))return cb?.({ok:false,error:"Invalid vote."});
    if(r.phase==="revote"&&!r.revoteTargets.includes(targetId))return cb?.({ok:false,error:"You can only vote for a tied player."});
    if(r.votes.has(socket.id))return cb?.({ok:false,error:"You have already voted."});
    r.votes.set(socket.id,targetId); cb?.({ok:true}); sendRoom(r);
    if(connectedVotes(r)>=connectedPlayers(r).length)resolveVote(r);
  });
  socket.on("game:lastGuess",({code,guess},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r||r.phase!=="imposter_guess"||socket.id!==r.imposterId)return cb?.({ok:false,error:"You don't have a last-chance guess right now."});
    clearTimer(r);
    const correct=String(guess||"").trim().toUpperCase().replace(/\s+/g," ")===r.mainWord.toUpperCase();
    if(correct)r.players.get(socket.id).score+=1;
    cb?.({ok:true,correct}); revealRound(r,true,r.lastVoteCounts,r.lastReason,correct);
  });
  socket.on("game:next",({code},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r||socket.id!==r.hostId||r.phase!=="results")return cb?.({ok:false,error:"Only the host can continue."});
    if(r.round>=r.totalRounds){r.phase="matchover"; r.lastResult={...(r.lastResult||{}),leaderboard:leaderboard(r)}; cb?.({ok:true,matchover:true}); sendRoom(r); io.to(r.code).emit("game:notice","Match complete! Final leaderboard is ready."); return;}
    r.round++; r.lastResult=null; cb?.({ok:true}); beginRound(r);
  });
  socket.on("game:newMatch",({code},cb)=>{
    const r=rooms.get(String(code||"").toUpperCase()); if(!r||socket.id!==r.hostId||r.phase!=="matchover")return cb?.({ok:false,error:"Only the host can start a new match."});
    resetMatch(r); cb?.({ok:true}); sendRoom(r);
  });
  socket.on("disconnect",()=>{
    for(const r of rooms.values()){
      const p=r.players.get(socket.id); if(!p) continue;
      p.connected=false; sendRoom(r);
      if(p.dropTimer) clearTimeout(p.dropTimer);
      p.dropTimer=setTimeout(()=>handleAbsence(r,p),GRACE_MS);
      if(connectedPlayers(r).length===0) scheduleCleanup(r);
    }
  });
});
server.listen(PORT,()=>console.log(`IMPOSTER running on http://localhost:${PORT}`));
