/* Ledger — Production‑Grade Double Entry Accounting */
const SUPABASE_URL = 'https://hubcmldbztdsxxqsoebo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh1YmNtbGRienRkc3h4cXNvZWJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2MzA2MTcsImV4cCI6MjA5MDIwNjYxN30.jevxOC3NeKqM16MUCcpy4NznWH8DausdYcjyHsJcuu8';
const CURRENCY = '₨';
const PAGE_SIZE = 20;
const PINNED_KEY = 'ledger_pinned_accounts';

let supabase, currentUser = null, currentTab = 'dashboard', editingVoucherId = null, editingVoucherStatus = null, tempEntries = [], confirmCb = null, viewingVoucherId = null;

// ───────────────────────────────────────────────────────── UTILS
function formatDate(d) { return d ? new Date(d).toLocaleDateString() : ''; }
function formatMoney(amt, sign=false) { let a=Math.abs(amt||0); let f=a.toLocaleString(undefined,{minimumFractionDigits:2}); let r=`${CURRENCY} ${f}`; return sign && amt<0 ? `-${r}` : r; }
function escapeHtml(s) { return s?.replace(/[&<>]/g, function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[m];}) || ''; }
function showToast(msg, type='success') { let t=document.getElementById('toast'); t.textContent=msg; t.className=`toast ${type}`; setTimeout(()=>t.classList.add('hidden'),3000); }
function setLoading(btn,loading){ btn.disabled=loading; if(loading)btn.classList.add('btn-loading'); else btn.classList.remove('btn-loading');}
function getPinned() { try{ return JSON.parse(localStorage.getItem(PINNED_KEY+'_'+(currentUser?.id||''))||'[]'); }catch{return[];} }
function setPinned(ids){ localStorage.setItem(PINNED_KEY+'_'+(currentUser?.id||''),JSON.stringify(ids));}
function togglePin(id){ let p=getPinned(); let idx=p.indexOf(id); idx>=0?p.splice(idx,1):p.push(id); setPinned(p); renderAccounts(); renderDashboard();}

// Normal balance helper
function getNormalBalance(type){
  if(type==='asset'||type==='expense') return 'debit';
  return 'credit';
}

// ───────────────────────────────────────────────────────── SUPABASE & AUTH
async function initSupabase(){
  const {createClient}=window.supabase;
  supabase=createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
  supabase.auth.onAuthStateChange((e,session)=>{ currentUser=session?.user||null; if(currentUser){ showApp(); updateUser(); renderDashboard(); } else showAuth(); });
  let {data:{session}}=await supabase.auth.getSession();
  currentUser=session?.user||null;
  currentUser? (showApp(),renderDashboard()):showAuth();
}
function showAuth(){ document.getElementById('auth-screen').classList.remove('hidden'); document.getElementById('app').classList.add('hidden'); setAuthMode('signin'); }
function showApp(){ document.getElementById('auth-screen').classList.add('hidden'); document.getElementById('app').classList.remove('hidden'); updateUser(); }
function updateUser(){ if(currentUser) document.getElementById('user-email').textContent=currentUser.email; }
function setAuthMode(mode){
  let form=document.getElementById('auth-form'), title=document.getElementById('auth-title'), links=document.getElementById('auth-links'), btn=document.getElementById('btn-auth-submit');
  form.innerHTML=''; links.innerHTML='';
  if(mode==='signin'){ title.textContent='Sign In'; form.innerHTML='<input type="email" id="auth-email" placeholder="Email"/><input type="password" id="auth-password" placeholder="Password"/>'; links.innerHTML='<button data-mode="signup">Create Account</button><button data-mode="forgot">Forgot?</button>'; btn.textContent='Sign In';}
  else if(mode==='signup'){ title.textContent='Create Account'; form.innerHTML='<input type="email" id="auth-email"/><input type="password" id="auth-password" placeholder="Password (min8)"/><input type="password" id="auth-confirm" placeholder="Confirm"/>'; links.innerHTML='<button data-mode="signin">Back</button>'; btn.textContent='Sign Up';}
  else{ title.textContent='Reset Password'; form.innerHTML='<input type="email" id="auth-email"/>'; links.innerHTML='<button data-mode="signin">Back</button>'; btn.textContent='Send Reset';}
  document.querySelectorAll('#auth-form input').forEach(i=>i.addEventListener('keypress',e=>e.key==='Enter'&&submitAuth()));
  links.querySelectorAll('button').forEach(b=>b.addEventListener('click',e=>setAuthMode(b.dataset.mode)));
}
async function submitAuth(){
  let mode=document.getElementById('auth-title').textContent, email=document.getElementById('auth-email')?.value, pass=document.getElementById('auth-password')?.value, errDiv=document.getElementById('auth-error'), btn=document.getElementById('btn-auth-submit');
  setLoading(btn,true); errDiv.textContent='';
  try{
    if(mode==='Sign In'){ let {error}=await supabase.auth.signInWithPassword({email,password:pass}); if(error)throw error; }
    else if(mode==='Create Account'){ let conf=document.getElementById('auth-confirm')?.value; if(pass!==conf)throw new Error('Passwords mismatch'); if(pass.length<8)throw new Error('Min 8 chars'); let {error}=await supabase.auth.signUp({email,password:pass}); if(error)throw error; errDiv.textContent='Check email to confirm'; errDiv.style.background='#D1FAE5';}
    else{ let {error}=await supabase.auth.resetPasswordForEmail(email); if(error)throw error; errDiv.textContent='Reset link sent'; errDiv.style.background='#D1FAE5';}
  }catch(e){ errDiv.textContent=e.message; errDiv.style.display='block';}
  finally{ setLoading(btn,false); }
}
async function logout(){ await supabase.auth.signOut(); currentUser=null; showAuth(); }

// ───────────────────────────────────────────────────────── ACCOUNTS
async function getAccounts(page=0){
  let {data,count,error}=await supabase.from('accounts').select('*',{count:'exact'}).eq('user_id',currentUser.id).order('name').range(page*PAGE_SIZE,(page+1)*PAGE_SIZE-1);
  if(error) throw error;
  return {data:data||[],total:count||0};
}
async function getAccount(id){ let {data,error}=await supabase.from('accounts').select('*').eq('id',id).eq('user_id',currentUser.id).single(); if(error)throw error; return data; }
async function saveAccount(name,type,opening,id=null){
  let rec={user_id:currentUser.id, name:name.trim(), type, opening_balance:parseFloat(opening)||0};
  if(id) await supabase.from('accounts').update(rec).eq('id',id).eq('user_id',currentUser.id);
  else await supabase.from('accounts').insert([rec]);
}
async function deleteAccount(id){
  let {count}=await supabase.from('voucher_entries').select('*',{count:'exact'}).eq('account_id',id);
  if(count>0) throw new Error('Account has transactions');
  await supabase.from('accounts').delete().eq('id',id).eq('user_id',currentUser.id);
}
async function computeBalance(accId,asOfDate=null){
  let acc=await getAccount(accId);
  if(!acc) return 0;
  let q=supabase.from('voucher_entries').select('debit,credit').eq('account_id',accId);
  if(asOfDate) q=q.lte('vouchers.date',asOfDate);
  let {data}=await q;
  let sumDebit=data?.reduce((s,e)=>s+(e.debit||0),0)||0;
  let sumCredit=data?.reduce((s,e)=>s+(e.credit||0),0)||0;
  let balance=acc.opening_balance||0;
  let normal=getNormalBalance(acc.type);
  if(normal==='debit') balance += sumCredit - sumDebit;
  else balance += sumDebit - sumCredit;
  return balance;
}
async function ensureCash(){
  let {data}=await supabase.from('accounts').select('id').eq('user_id',currentUser.id).eq('name','Cash').single();
  if(!data) await saveAccount('Cash','asset',0);
}

// ───────────────────────────────────────────────────────── VOUCHERS
async function getNextVoucherId(){
  let {data}=await supabase.from('counters').select('next_value').eq('user_id',currentUser.id).eq('name','voucher_id').single();
  if(!data){ await supabase.from('counters').insert([{user_id:currentUser.id,name:'voucher_id',next_value:1}]); return 'V-001'; }
  let n=data.next_value;
  await supabase.from('counters').update({next_value:n+1}).eq('user_id',currentUser.id).eq('name','voucher_id');
  return `V-${String(n).padStart(3,'0')}`;
}
async function saveVoucher(date,entries,status,id=null){
  if(!date) throw new Error('Date required');
  if(entries.length===0) throw new Error('At least one entry');
  let debitSum=entries.reduce((s,e)=>s+(parseFloat(e.debit)||0),0);
  let creditSum=entries.reduce((s,e)=>s+(parseFloat(e.credit)||0),0);
  if(Math.abs(debitSum-creditSum)>0.001) throw new Error('Debit ≠ Credit');
  let voucherId=id;
  if(!voucherId){
    let newId=await getNextVoucherId();
    let {data}=await supabase.from('vouchers').insert([{user_id:currentUser.id, id:newId, date, status}]).select().single();
    voucherId=data.id;
  } else {
    await supabase.from('vouchers').update({date,status}).eq('id',id).eq('user_id',currentUser.id);
    await supabase.from('voucher_entries').delete().eq('voucher_id',id);
  }
  let entryRecs=entries.map((e,idx)=>({voucher_id:voucherId, user_id:currentUser.id, sn:idx+1, account_id:e.account_id, narration:e.narration?.trim(), debit:parseFloat(e.debit)||0, credit:parseFloat(e.credit)||0}));
  await supabase.from('voucher_entries').insert(entryRecs);
}
async function getVouchers(page=0){
  let {data,count}=await supabase.from('vouchers').select('*',{count:'exact'}).eq('user_id',currentUser.id).order('date',{ascending:false}).range(page*PAGE_SIZE,(page+1)*PAGE_SIZE-1);
  return {data:data||[],total:count||0};
}
async function getVoucher(id){
  let {data:v}=await supabase.from('vouchers').select('*').eq('id',id).eq('user_id',currentUser.id).single();
  if(!v) return null;
  let {data:entries}=await supabase.from('voucher_entries').select('*').eq('voucher_id',id).order('sn');
  return {...v,entries:entries||[]};
}
async function deleteVoucher(id){
  await supabase.from('voucher_entries').delete().eq('voucher_id',id);
  await supabase.from('vouchers').delete().eq('id',id).eq('user_id',currentUser.id);
}
async function getLedger(accId,from,to){
  let acc=await getAccount(accId);
  let query=supabase.from('voucher_entries').select('*, vouchers(date,id)').eq('account_id',accId);
  if(from) query=query.gte('vouchers.date',from);
  if(to) query=query.lte('vouchers.date',to);
  let {data}=await query.order('vouchers.date');
  let balance=acc.opening_balance||0;
  let normal=getNormalBalance(acc.type);
  return (data||[]).map(e=>{
    let d=e.debit||0, c=e.credit||0;
    if(normal==='debit') balance += c-d;
    else balance += d-c;
    return {...e, running:balance};
  });
}
// Trial Balance
async function trialBalance(){
  let {data:accounts}=await getAccounts(0);
  let rows=[];
  for(let a of accounts){
    let bal=await computeBalance(a.id);
    let normal=getNormalBalance(a.type);
    let debitBal=0, creditBal=0;
    if(normal==='debit') debitBal=bal>0?bal:0;
    else creditBal=bal>0?bal:0;
    rows.push({name:a.name,debit:debitBal,credit:creditBal});
  }
  return rows;
}
// ───────────────────────────────────────────────────────── RENDER FUNCTIONS
async function renderDashboard(){
  let {data:accs}=await getAccounts(0);
  document.getElementById('dash-accounts').textContent=accs.length;
  let cash=accs.find(a=>a.name==='Cash');
  let cashBal=cash?await computeBalance(cash.id):0;
  document.getElementById('dash-cash-balance').textContent=formatMoney(cashBal);
  let {total:vCount}=await getVouchers(0);
  document.getElementById('dash-vouchers').textContent=vCount;
  let pinned=getPinned();
  if(pinned.length){
    let pinnedHtml='';
    for(let id of pinned){
      let a=accs.find(x=>x.id===id);
      if(a) pinnedHtml+=`<div class="pinned-card" data-id="${a.id}"><div class="pinned-name">${escapeHtml(a.name)}</div><div class="pinned-balance">${formatMoney(await computeBalance(a.id))}</div></div>`;
    }
    document.getElementById('dash-pinned').innerHTML=pinnedHtml;
    document.getElementById('dash-pinned-section').style.display='block';
    document.querySelectorAll('.pinned-card').forEach(c=>c.addEventListener('click',()=>viewLedger(c.dataset.id)));
  }else document.getElementById('dash-pinned-section').style.display='none';
  let {data:vouchers}=await getVouchers(0);
  document.getElementById('dash-recent').innerHTML=vouchers.slice(0,5).map(v=>`<div class="list-item" data-id="${v.id}"><div class="li-content"><div class="li-title">${escapeHtml(v.id)}</div><div class="li-subtitle">${formatDate(v.date)}</div></div><div class="li-right"><button class="btn-icon" onclick="event.stopPropagation();openVoucherView('${v.id}')"><svg width="14" height="14"><use href="#ic-edit"/></svg></button></div></div>`).join('')||'<p>No transactions</p>';
  document.querySelectorAll('#dash-recent .list-item').forEach(i=>i.addEventListener('click',()=>openVoucherView(i.dataset.id)));
}
async function renderAccounts(){
  let {data:accs}=await getAccounts(0);
  let filter=document.getElementById('account-filter').value;
  let search=document.getElementById('account-search').value.toLowerCase();
  let filtered=accs.filter(a=>(filter==='all'||a.type===filter)&&a.name.toLowerCase().includes(search));
  let html='';
  for(let a of filtered){
    let bal=await computeBalance(a.id);
    let pinned=getPinned().includes(a.id);
    html+=`<div class="list-item"><div class="li-content" onclick="editAccount('${a.id}')"><div class="li-title">${escapeHtml(a.name)}<span style="font-size:0.7rem; margin-left:0.5rem; color:var(--text-light)">${a.type}</span></div><div class="li-subtitle">Opening: ${formatMoney(a.opening_balance)}</div></div><div class="li-right"><div class="li-balance ${bal>=0?'positive':'negative'}">${formatMoney(bal)}</div><div class="li-actions"><button class="btn-icon ${pinned?'pin':''}" onclick="togglePin('${a.id}');renderAccounts()"><svg width="12" height="12"><use href="#ic-pin"/></svg></button><button class="btn-icon" onclick="deleteAccountConfirm('${a.id}')"><svg width="12" height="12"><use href="#ic-trash"/></svg></button></div></div></div>`;
  }
  document.getElementById('accounts-list').innerHTML=html||'<p>No accounts</p>';
}
async function renderTransactions(){
  let {data:vouchers}=await getVouchers(0);
  let search=document.getElementById('voucher-search').value.toLowerCase();
  let filtered=vouchers.filter(v=>v.id.toLowerCase().includes(search)||formatDate(v.date).toLowerCase().includes(search));
  document.getElementById('vouchers-list').innerHTML=filtered.map(v=>`<div class="list-item" data-id="${v.id}"><div class="li-content"><div class="li-title">${escapeHtml(v.id)}<span style="margin-left:8px;font-size:0.7rem;background:${v.status==='posted'?'#D1FAE5':'#FEF3C7'};padding:2px 6px;border-radius:20px;">${v.status||'draft'}</span></div><div class="li-subtitle">${formatDate(v.date)}</div></div><div class="li-right"><button class="btn-icon" onclick="event.stopPropagation();editVoucher('${v.id}','${v.status}')"><svg width="14" height="14"><use href="#ic-edit"/></svg></button></div></div>`).join('');
  document.querySelectorAll('#vouchers-list .list-item').forEach(i=>i.addEventListener('click',()=>openVoucherView(i.dataset.id)));
}
async function renderReports(){ let {data:accs}=await getAccounts(0); document.getElementById('report-accounts-list').innerHTML=accs.map(a=>`<option>${escapeHtml(a.name)}</option>`).join(''); let today=new Date(); let firstDay=new Date(today.getFullYear(),today.getMonth(),1); document.getElementById('report-from').valueAsDate=firstDay; document.getElementById('report-to').valueAsDate=today; }
function viewLedger(accId){ document.querySelector('[data-tab="reports"]').click(); setTimeout(()=>document.getElementById('report-account-text').value=accId,100); }
async function generateReport(){
  let accName=document.getElementById('report-account-text').value;
  let from=document.getElementById('report-from').value, to=document.getElementById('report-to').value;
  let {data:accs}=await getAccounts(0);
  let acc=accs.find(a=>a.name===accName);
  if(!acc) return showToast('Select account','error');
  let entries=await getLedger(acc.id,from,to);
  let rows=entries.map(e=>`<tr><td>${formatDate(e.vouchers.date)}</td><td>${escapeHtml(e.vouchers.id)}</td><td>${escapeHtml(e.narration||'')}</td><td style="text-align:right;color:var(--error)">${formatMoney(e.debit)}</td><td style="text-align:right;color:var(--success)">${formatMoney(e.credit)}</td><td style="text-align:right;font-weight:600">${formatMoney(e.running)}</td></tr>`);
  let html=`<div id="print-report"><h3>${escapeHtml(acc.name)} Ledger</h3><p>${formatDate(from)} — ${formatDate(to)}</p><table style="width:100%;border-collapse:collapse;"><thead><tr><th>Date</th><th>Voucher</th><th>Narration</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  document.getElementById('report-output').innerHTML=html;
}
async function trialBalanceReport(){
  let tb=await trialBalance();
  let html=`<div id="print-report"><h3>Trial Balance</h3><table style="width:100%"><thead><tr><th>Account</th><th>Debit (₨)</th><th>Credit (₨)</th></tr></thead><tbody>${tb.map(r=>`<tr><td>${escapeHtml(r.name)}</td><td style="text-align:right">${formatMoney(r.debit)}</td><td style="text-align:right">${formatMoney(r.credit)}</td></tr>`).join('')}</tbody></table></div>`;
  document.getElementById('report-output').innerHTML=html;
}
function exportPDF(){ let el=document.getElementById('print-report'); if(!el) return showToast('Generate report first','error'); html2pdf().set({margin:10,filename:'ledger.pdf',image:{type:'png',quality:0.98},html2canvas:{scale:2},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}}).from(el).save(); }
// ───────────────────────────────────────────────────────── VOUCHER MODAL
function openVoucherModal(id=null,status=null){
  editingVoucherId=id; editingVoucherStatus=status; tempEntries=[];
  document.getElementById('modal-voucher-title').textContent=id?'Edit Voucher':'New Voucher';
  document.getElementById('v-date').value=new Date().toISOString().slice(0,10);
  document.getElementById('v-id').value=id||'Auto';
  renderVoucherEntriesTable();
  if(id) loadVoucherForEdit(id);
  openModal('modal-voucher');
}
async function loadVoucherForEdit(id){
  let v=await getVoucher(id);
  if(v){ document.getElementById('v-date').value=v.date; tempEntries=v.entries.map(e=>({...e})); renderVoucherEntriesTable(); }
}
function renderVoucherEntriesTable(){
  let container=document.getElementById('voucher-entries-list');
  container.innerHTML=tempEntries.map((e,idx)=>`<div class="entry-row" data-idx="${idx}"><div class="entry-sn">${idx+1}</div><select class="entry-account" data-idx="${idx}"><option value="">—Select—</option></select><input class="entry-narration" data-idx="${idx}" value="${escapeHtml(e.narration||'')}" placeholder="Narration"/><input class="entry-debit" data-idx="${idx}" type="number" step="0.01" value="${e.debit||0}"/><input class="entry-credit" data-idx="${idx}" type="number" step="0.01" value="${e.credit||0}"/><button class="entry-remove" data-idx="${idx}">✕</button></div>`).join('');
  populateAccountSelects();
  attachEntryEvents();
  checkVoucherBalance();
}
async function populateAccountSelects(){
  let {data:accounts}=await getAccounts(0);
  let selects=document.querySelectorAll('.entry-account');
  for(let sel of selects){
    let idx=sel.dataset.idx;
    let current=tempEntries[idx]?.account_id||'';
    sel.innerHTML='<option value="">—Select—</option>'+accounts.map(a=>`<option value="${a.id}" ${a.id===current?'selected':''}>${escapeHtml(a.name)} (${a.type})</option>`).join('');
  }
}
function attachEntryEvents(){
  document.querySelectorAll('.entry-account').forEach(s=>s.addEventListener('change',e=>{ let idx=e.target.dataset.idx; tempEntries[idx].account_id=e.target.value; }));
  document.querySelectorAll('.entry-narration').forEach(i=>i.addEventListener('change',e=>{ tempEntries[e.target.dataset.idx].narration=e.target.value; }));
  document.querySelectorAll('.entry-debit').forEach(i=>i.addEventListener('input',e=>{ let idx=e.target.dataset.idx; tempEntries[idx].debit=parseFloat(e.target.value)||0; if(tempEntries[idx].debit) tempEntries[idx].credit=0; document.querySelector(`.entry-credit[data-idx="${idx}"]`).value=0; checkVoucherBalance(); renderVoucherEntriesTable(); }));
  document.querySelectorAll('.entry-credit').forEach(i=>i.addEventListener('input',e=>{ let idx=e.target.dataset.idx; tempEntries[idx].credit=parseFloat(e.target.value)||0; if(tempEntries[idx].credit) tempEntries[idx].debit=0; document.querySelector(`.entry-debit[data-idx="${idx}"]`).value=0; checkVoucherBalance(); renderVoucherEntriesTable(); }));
  document.querySelectorAll('.entry-remove').forEach(b=>b.addEventListener('click',()=>{ let idx=parseInt(b.dataset.idx); tempEntries.splice(idx,1); renderVoucherEntriesTable(); }));
}
function checkVoucherBalance(){
  let debit=tempEntries.reduce((s,e)=>s+(e.debit||0),0);
  let credit=tempEntries.reduce((s,e)=>s+(e.credit||0),0);
  let diff=debit-credit;
  let row=document.getElementById('balance-check-row');
  if(Math.abs(diff)<0.001){ row.textContent='✓ Balanced'; row.classList.add('balanced'); }
  else{ row.textContent=`✗ Unbalanced (${formatMoney(diff)})`; row.classList.remove('balanced'); }
}
async function addEntryFromModal(){
  document.getElementById('entry-account-select').innerHTML='<option value="">—Select—</option>';
  let {data:accounts}=await getAccounts(0);
  document.getElementById('entry-account-select').innerHTML+=accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  document.getElementById('entry-debit').value=''; document.getElementById('entry-credit').value=''; document.getElementById('entry-narration').value='';
  openModal('modal-entry');
  document.getElementById('entry-debit').disabled=false; document.getElementById('entry-credit').disabled=false;
  document.getElementById('entry-debit').addEventListener('input',function(){ if(this.value) document.getElementById('entry-credit').value=''; document.getElementById('entry-credit').disabled=!!this.value; });
  document.getElementById('entry-credit').addEventListener('input',function(){ if(this.value) document.getElementById('entry-debit').value=''; document.getElementById('entry-debit').disabled=!!this.value; });
  let saveBtn=document.getElementById('btn-save-entry');
  saveBtn.onclick=()=>{
    let acc=document.getElementById('entry-account-select').value;
    if(!acc) return showToast('Select account','error');
    let narration=document.getElementById('entry-narration').value;
    let debit=parseFloat(document.getElementById('entry-debit').value)||0;
    let credit=parseFloat(document.getElementById('entry-credit').value)||0;
    if(debit===0&&credit===0) return showToast('Debit or credit required','error');
    tempEntries.push({account_id:acc,narration,debit,credit});
    renderVoucherEntriesTable();
    closeModal('modal-entry');
    checkVoucherBalance();
  };
}
async function saveVoucherFinal(status){
  let date=document.getElementById('v-date').value;
  if(!date) return showToast('Date required','error');
  try{
    await saveVoucher(date,tempEntries,status,editingVoucherId);
    closeModal('modal-voucher');
    renderTransactions();
    showToast(status==='posted'?'Voucher posted':'Draft saved','success');
  }catch(e){ showToast(e.message,'error'); }
}
// View voucher
async function openVoucherView(id){
  viewingVoucherId=id;
  let v=await getVoucher(id);
  if(!v) return;
  let {data:accounts}=await getAccounts(0);
  let map=Object.fromEntries(accounts.map(a=>[a.id,a.name]));
  let entriesHtml=v.entries.map(e=>`<tr><td>${e.sn}</td><td>${escapeHtml(map[e.account_id]||'')}</td><td>${escapeHtml(e.narration||'')}</td><td style="text-align:right;color:var(--error)">${formatMoney(e.debit)}</td><td style="text-align:right;color:var(--success)">${formatMoney(e.credit)}</td></tr>`).join('');
  let debitSum=v.entries.reduce((s,e)=>s+(e.debit||0),0);
  let creditSum=v.entries.reduce((s,e)=>s+(e.credit||0),0);
  let html=`<div><div class="form-row"><div><label>ID</label><div>${escapeHtml(v.id)}</div></div><div><label>Date</label><div>${formatDate(v.date)}</div></div><div><label>Status</label><div><span style="background:${v.status==='posted'?'#D1FAE5':'#FEF3C7'};padding:2px 8px;border-radius:20px;">${v.status||'draft'}</span></div></div></div><table style="width:100%;border-collapse:collapse;"><thead><tr><th>#</th><th>Account</th><th>Narration</th><th>Debit</th><th>Credit</th></tr></thead><tbody>${entriesHtml}<tr style="font-weight:600;background:var(--bg-hover);"><td colspan="3">Total</td><td style="text-align:right">${formatMoney(debitSum)}</td><td style="text-align:right">${formatMoney(creditSum)}</td></tr></tbody></table></div>`;
  document.getElementById('modal-vview-body').innerHTML=html;
  openModal('modal-voucher-view');
  document.getElementById('btn-vview-edit').onclick=()=>{ closeModal('modal-voucher-view'); openVoucherModal(viewingVoucherId,v.status); };
  document.getElementById('btn-vview-delete').onclick=()=>showConfirm('Delete voucher?',async()=>{ await deleteVoucher(viewingVoucherId); closeModal('modal-voucher-view'); renderTransactions(); showToast('Deleted'); });
}
// ───────────────────────────────────────────────────────── MODAL & HELPERS
function openModal(id){ document.getElementById('modal-overlay').classList.remove('hidden'); document.getElementById(id).style.display='flex'; }
function closeModal(id){ document.getElementById(id).style.display='none'; if(!document.querySelector('.modal[style*="flex"]')) document.getElementById('modal-overlay').classList.add('hidden'); }
function showConfirm(msg,cb){ confirmCb=cb; document.getElementById('confirm-msg').textContent=msg; openModal('modal-confirm'); }
document.getElementById('confirm-ok').onclick=()=>{ closeModal('modal-confirm'); if(confirmCb) confirmCb(); };
document.getElementById('confirm-cancel').onclick=()=>closeModal('modal-confirm');
async function editAccount(id){ let acc=await getAccount(id); document.getElementById('acc-name').value=acc.name; document.getElementById('acc-type').value=acc.type; document.getElementById('acc-opening').value=acc.opening_balance; editingAccountId=id; openModal('modal-account'); }
async function deleteAccountConfirm(id){ let acc=await getAccount(id); showConfirm(`Delete "${acc.name}"?`,async()=>{ await deleteAccount(id); renderAccounts(); showToast('Deleted'); }); }
async function saveAccountClick(){ let name=document.getElementById('acc-name').value, type=document.getElementById('acc-type').value, opening=document.getElementById('acc-opening').value; if(!name) return showToast('Name required','error'); await saveAccount(name,type,opening,editingAccountId); closeModal('modal-account'); renderAccounts(); showToast('Saved'); }
function setupEvents(){
  document.querySelectorAll('.nav-item,.bn-item').forEach(b=>b.addEventListener('click',()=>{ let tab=b.dataset.tab; document.querySelectorAll('.nav-item,.bn-item').forEach(x=>x.classList.remove('active')); b.classList.add('active'); document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active')); document.getElementById(`tab-${tab}`).classList.add('active'); if(tab==='dashboard')renderDashboard(); else if(tab==='accounts')renderAccounts(); else if(tab==='transactions')renderTransactions(); else if(tab==='reports')renderReports(); }));
  document.getElementById('btn-new-account').onclick=()=>{ editingAccountId=null; document.getElementById('acc-name').value=''; document.getElementById('acc-type').value='asset'; document.getElementById('acc-opening').value=''; openModal('modal-account'); };
  document.getElementById('btn-save-account').onclick=saveAccountClick;
  document.getElementById('btn-new-voucher').onclick=()=>openVoucherModal();
  document.getElementById('btn-add-entry').onclick=addEntryFromModal;
  document.getElementById('btn-save-draft').onclick=()=>saveVoucherFinal('draft');
  document.getElementById('btn-post-voucher').onclick=()=>saveVoucherFinal('posted');
  document.getElementById('btn-generate-report').onclick=generateReport;
  document.getElementById('btn-trial-balance').onclick=trialBalanceReport;
  document.getElementById('btn-print-report').onclick=exportPDF;
  document.getElementById('btn-change-password').onclick=async()=>{ let p=document.getElementById('new-password').value, c=document.getElementById('confirm-new-password').value; if(p!==c) return showToast('Passwords mismatch','error'); if(p.length<8) return showToast('Min 8 chars','error'); await supabase.auth.updateUser({password:p}); showToast('Password updated'); };
  document.getElementById('btn-logout').onclick=logout; document.getElementById('btn-logout-top').onclick=logout; document.getElementById('btn-logout-settings').onclick=logout;
  document.getElementById('account-search').addEventListener('input',renderAccounts);
  document.getElementById('account-filter').addEventListener('change',renderAccounts);
  document.getElementById('voucher-search').addEventListener('input',renderTransactions);
  document.querySelectorAll('.modal-x, [data-modal]').forEach(btn=>btn.addEventListener('click',()=>closeModal(btn.dataset.modal||btn.closest('.modal')?.id)));
  document.getElementById('modal-overlay').addEventListener('click',e=>{ if(e.target.id==='modal-overlay'){ document.querySelectorAll('.modal').forEach(m=>m.style.display='none'); document.getElementById('modal-overlay').classList.add('hidden'); }});
  document.addEventListener('keydown',e=>{ if(e.ctrlKey&&e.key==='a'&&document.getElementById('modal-voucher').style.display==='flex'){ e.preventDefault(); addEntryFromModal(); } });
}
document.addEventListener('DOMContentLoaded',async()=>{ setupEvents(); await initSupabase(); if(currentUser) await ensureCash(); });
window.togglePin=togglePin; window.editAccount=editAccount; window.deleteAccountConfirm=deleteAccountConfirm; window.openVoucherView=openVoucherView; window.editVoucher=openVoucherModal;
