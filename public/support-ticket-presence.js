(()=>{
  const root=document.getElementById('support-ticket-presence');
  const token=document.querySelector('meta[name="csrf-token"]')?.content||'';
  const ticketId=root?.dataset.ticketId||'';
  if(!ticketId||!token)return;
  const heartbeat=()=>fetch(`/operations/support/tickets/${encodeURIComponent(ticketId)}/presence`,{method:'POST',credentials:'same-origin',headers:{accept:'application/json','x-csrf-token':token},keepalive:true}).catch(()=>{});
  const timer=setInterval(heartbeat,30_000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')heartbeat();});
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
