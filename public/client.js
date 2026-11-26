const socket=io();
const $=id=>document.getElementById(id);
let roomCode=null,myId=null,roomState=null,mySecret=null,currentTurn=null,selectedVote=null,hasVoted=false,isHost=false,lastPhase=null;
const SKEY="imposterSession";
const saveSession=(code,token)=>{try{sessionStorage.setItem(SKEY,JSON.stringify({code,token}));}catch{}};
const loadSession=()=>{try{return JSON.parse(sessionStorage.getItem(SKEY)||"null");}catch{return null;}};
const clearSession=()=>{try{sessionStorage.removeItem(SKEY);}catch{}};
const show=(id,yes=true)=>$(id).classList.toggle("hidden",!yes);
function setError(id,msg=""){ $(id).textContent=msg; }
function emitAck(event,data){return new Promise(resolve=>socket.emit(event,data,resolve));}
function nameValue(){return $("name").value.trim()||"Player";}
function enterRoom(code){roomCode=code;$("codeLabel").textContent=code;$("shareCode").textContent=code;show("home",false);show("game",true);$("messages").innerHTML="";}
$("create").onclick=async()=>{const res=await emitAck("room:create",{name:nameValue(),totalRounds:5});if(!res?.ok)return setError("homeError",res?.error||"Could not create room.");myId=socket.id;saveSession(res.code,res.token);enterRoom(res.code);};
$("join").onclick=async()=>{const res=await emitAck("room:join",{code:$('roomCode').value.trim().toUpperCase(),name:nameValue()});if(!res?.ok)return setError("homeError",res?.error||"Could not join room.");myId=socket.id;saveSession(res.code,res.token);enterRoom(res.code);};
$("copy").onclick=async()=>{try{await navigator.clipboard.writeText(roomCode);$('copy').textContent="Copied!";}catch{$('copy').textContent=roomCode;}};
$("roundSetting").onchange=async()=>{if(!roomCode||!isHost)return;const res=await emitAck("game:setRounds",{code:roomCode,totalRounds:$('roundSetting').value});if(!res?.ok)setError("gameError",res?.error||"Could not update rounds.");};
$("start").onclick=async()=>{const res=await emitAck("game:start",{code:roomCode});if(!res?.ok)setError("gameError",res?.error||"Unable to start.");};
$("next").onclick=async()=>{const res=await emitAck("game:next",{code:roomCode});if(!res?.ok)setError("gameError",res?.error||"Unable to continue.");};
$("newMatch").onclick=async()=>{const res=await emitAck("game:newMatch",{code:roomCode});if(!res?.ok)setError("gameError",res?.error||"Unable to start a new match.");};
$("sendClue").onclick=submitClue;$("clueInput").addEventListener("keydown",e=>{if(e.key==="Enter")submitClue();});
async function submitClue(){const text=$("clueInput").value.trim();const res=await emitAck("game:clue",{code:roomCode,text});if(!res?.ok)return setError("gameError",res?.error||"Could not submit clue.");$("clueInput").value="";show("clueForm",false);}
$("chatForm").onsubmit=async e=>{e.preventDefault();const text=$("chatInput").value.trim();if(!text)return;const res=await emitAck("chat:send",{code:roomCode,text});if(!res?.ok)setError("gameError",res?.error||"Chat unavailable.");else $("chatInput").value="";};
$("guessForm").onsubmit=async e=>{e.preventDefault();const guess=$("guessInput").value.trim();if(!guess)return;const res=await emitAck("game:lastGuess",{code:roomCode,guess});if(!res?.ok)return setError("gameError",res?.error||"Guess failed.");show("guessForm",false);$("guessFeedback").textContent=res.correct?"Correct! +1 point.":"Not quite—no bonus point.";};
socket.on("connect",async()=>{
  myId=socket.id;
  const saved=loadSession(); if(!saved?.code||!saved?.token)return;
  const res=await emitAck("room:rejoin",saved);
  if(res?.ok){lastPhase=res.phase;hasVoted=!!res.hasVoted;if(!roomCode)enterRoom(res.code);else roomCode=res.code;setError("gameError","");}
  else{clearSession();if(roomCode){roomCode=null;show("game",false);show("home",true);setError("homeError","You were disconnected too long and could not rejoin that game.");}}
});
socket.on("room:update",r=>{
  if(roomCode&&r.code!==roomCode)return;roomState=r;isHost=r.hostId===socket.id;
  if(r.phase!==lastPhase){if(r.phase==="voting"||r.phase==="revote")hasVoted=false;lastPhase=r.phase;}
  $('roundLabel').textContent=`${r.round}/${r.totalRounds}`;$('playerCount').textContent=`${r.playersCount}/${r.maxPlayers}`;
  $('players').innerHTML=r.players.map(p=>`<div class="player"><span class="avatar">${escapeHtml(p.name.slice(0,1).toUpperCase())}</span><span>${escapeHtml(p.name)}${p.id===r.hostId?'<span class="host">HOST</span>':''}</span><span class="score">${p.score} pts</span></div>`).join("");
  $('leaderboard').innerHTML=r.leaderboard.map((p,i)=>`<div class="rank-row"><span class="rank">${i+1}</span><span>${escapeHtml(p.name)}</span><b>${p.score} pts</b></div>`).join("");
  $('clues').innerHTML=r.clues.map(c=>`<div class="clue"><b>${escapeHtml(c.name)}</b><span>${escapeHtml(c.text)}</span></div>`).join("");
  $('phaseLabel').textContent=r.phase.toUpperCase();$('chatStatus').textContent=["lobby","discussion","results","matchover"].includes(r.phase)?"Chat open":"Chat paused";
  $('chatInput').disabled=!["lobby","discussion","results","matchover"].includes(r.phase);$('chatForm').querySelector('button').disabled=$('chatInput').disabled;
  show("hostActions",isHost&&["lobby","results","matchover"].includes(r.phase));show("start",isHost&&r.phase==="lobby");show("next",isHost&&r.phase==="results");show("newMatch",isHost&&r.phase==="matchover");
  show("roundSettings",isHost&&r.phase==="lobby");$('roundSetting').value=String(r.totalRounds);
  if(r.phase==="lobby"){$('headline').textContent="Waiting for your friends";$('subhead').textContent=`Share the room code. ${r.playersCount}/${r.maxPlayers} players • need at least 3 to start.`;show("secretCard",false);show("turnBox",false);show("clueForm",false);show("voteBox",false);show("resultBox",false);show("guessForm",false);}
  else if(r.phase==="clues"){$('headline').textContent="Give your clue";$('subhead').textContent=`One clue per player (45 seconds each). ${r.currentTurnName?r.currentTurnName+" is up.":""}`;show("turnBox",true);$('turnBox').textContent=r.currentTurnName?`${r.currentTurnName}'s turn to give a clue`:"Clue round";show("clueForm",currentTurn===socket.id);show("voteBox",false);show("resultBox",false);show("guessForm",false);}
  else if(r.phase==="discussion"){$('headline').textContent="Discuss and investigate";$('subhead').textContent=`Talk it out. Voting starts when the timer ends. ${r.timeLeft}s remaining.`;show("turnBox",false);show("clueForm",false);show("voteBox",false);show("resultBox",false);show("guessForm",false);}
  else if(r.phase==="voting"||r.phase==="revote"){$('headline').textContent=r.phase==="revote"?"Tie-break revote":"Who is the imposter?";$('subhead').textContent=`${r.phase==="revote"?"Choose only from the tied players. ":"Choose one player. "}Votes are anonymous. ${r.timeLeft}s remaining.`;show("turnBox",false);show("clueForm",false);show("voteBox",true);show("resultBox",false);show("guessForm",false);
    const candidates=r.phase==="revote"?r.revoteTargets:r.players.filter(p=>p.id!==socket.id&&p.connected);$('votePlayers').innerHTML=candidates.filter(p=>p.id!==socket.id).map(p=>`<button data-id="${p.id}" ${hasVoted?"disabled":""}>${escapeHtml(p.name)}</button>`).join("");$('votePlayers').querySelectorAll('button').forEach(b=>b.onclick=()=>castVote(b.dataset.id));}
  else if(r.phase==="imposter_guess"){$('headline').textContent="Imposter’s last chance";$('subhead').textContent=`The imposter has one final guess for +1 point. ${r.timeLeft}s remaining.`;show("turnBox",false);show("clueForm",false);show("voteBox",false);show("resultBox",false);show("guessForm",!!mySecret?.isImposter);}
  else if(r.phase==="results"){$('headline').textContent="Round complete";$('subhead').textContent="Check the reveal and updated leaderboard.";show("turnBox",false);show("clueForm",false);show("voteBox",false);show("resultBox",true);show("guessForm",false);if(r.lastResult)renderResult(r.lastResult);}
  else if(r.phase==="matchover"){$('headline').textContent="Match complete!";$('subhead').textContent="Final standings are in. The host can start a new match.";show("turnBox",false);show("clueForm",false);show("voteBox",false);show("resultBox",true);show("guessForm",false);$('resultBox').innerHTML=`<strong>FINAL LEADERBOARD</strong><br>${r.leaderboard.map((p,i)=>`${i+1}. ${escapeHtml(p.name)} — ${p.score} pts`).join("<br>")}`;}
});
socket.on("game:secret",data=>{mySecret=data;hasVoted=false;selectedVote=null;show("secretCard",true);$('secretWord').textContent=data.word;$('roleHint').textContent=data.isImposter?"You are the IMPOSTER. Blend in!":"You are on the majority team. Find the imposter!";show("guessForm",false);$('guessFeedback').textContent="";});
socket.on("game:turn",data=>{currentTurn=data.playerId;if(roomState?.phase==="clues")show("clueForm",data.playerId===socket.id);$('turnBox').textContent=`${data.playerName}'s turn (${data.index}/${data.total})`;});
socket.on("game:notice",msg=>{$('subhead').textContent=msg;});
socket.on("game:lastChance",()=>{if(mySecret?.isImposter){show("guessForm",true);$('guessInput').value="";$('guessFeedback').textContent="";}});
socket.on("game:result",renderResult);
function renderResult(result){show("resultBox",true);$('resultBox').innerHTML=`<strong>${result.caught?"The imposter was caught!":"The imposter escaped!"}</strong><br>Imposter: <b>${escapeHtml(result.imposterName)}</b><br>Majority word: <b>${escapeHtml(result.mainWord)}</b><br>Imposter word: <b>${escapeHtml(result.imposterWord)}</b><br>${result.reason==="tie"?"The revote was still tied, so the imposter escaped.":""}<br>${result.caught?(result.guessed?"Imposter guessed correctly: +1 bonus.":"Imposter did not earn the last-chance bonus."):""}<br><br>${(result.voteCounts||[]).map(v=>`${escapeHtml(v.name)}: ${v.count} vote(s)`).join("<br>")}<br><br><b>Leaderboard</b><br>${(result.leaderboard||[]).map((p,i)=>`${i+1}. ${escapeHtml(p.name)} — ${p.score} pts`).join("<br>")}`;hasVoted=false;selectedVote=null;}
socket.on("chat:message",m=>{const div=document.createElement("div");div.className="message";const time=new Date(m.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});div.innerHTML=`<b>${escapeHtml(m.name)}</b>${escapeHtml(m.text)}<span class="time">${time}</span>`;$('messages').appendChild(div);$('messages').scrollTop=$('messages').scrollHeight;});
async function castVote(targetId){const res=await emitAck("game:vote",{code:roomCode,targetId});if(!res?.ok)return setError("gameError",res?.error||"Vote failed.");hasVoted=true;$('votePlayers').querySelectorAll('button').forEach(b=>b.disabled=true);$('subhead').textContent="Vote submitted. Waiting for everyone else...";}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
