// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// admin-bot.js — CLOUDE CART 🛒 | Admin Bot
// FIX: 409 conflict, join URL delete, ban system
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db  = require('./db');
const h   = require('./helpers');
const otpManager = require('./otp-manager');

const bot      = new TelegramBot(process.env.ADMIN_BOT_TOKEN, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});
bot.on('polling_error', (err) => {
  const msg = err && (err.message || err.code || String(err));
  console.error('[admin polling_error]', msg);
});
bot.on('error', (err) => console.error('[admin error]', err && err.message));

const _answeredCb = new Set();
async function safeAnswer(q, opts) {
  if (!q || !q.id || _answeredCb.has(q.id)) return;
  _answeredCb.add(q.id);
  try { await bot.answerCallbackQuery(q.id, opts || {}); } catch (_) {}
  if (_answeredCb.size > 2000) {
    [..._answeredCb].slice(0, 1000).forEach((id) => _answeredCb.delete(id));
  }
}

const OWNER_ID = String(process.env.OWNER_ID);
const PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_CHAT = process.env.ADMIN_NOTIFY_CHAT_ID;
const SUPPORT_GROUP = process.env.SUPPORT_GROUP_ID || '';

// Cross-bot setup — delayed so both files load first
let U = null;
setTimeout(() => {
  U = require('./user-bot');
  h.setBots(U.bot, bot);
}, 800);

// ── Auth ───────────────────────────────────────────────
const _auth = new Set();
function isAuth(id)  { return String(id)===OWNER_ID||db.isAdmin(String(id))||_auth.has(String(id)); }
function isOwner(id) { return String(id)===OWNER_ID; }

// ── Duplicate guard ────────────────────────────────────
const _seen = new Map();
function isDupe(id) {
  if (_seen.has(id)) return true;
  _seen.set(id,1); setTimeout(()=>_seen.delete(id),6000); return false;
}

const send = (c,t,o={}) => bot.sendMessage(c,t,{parse_mode:'HTML',...o});
async function edit(c,m,t,o={}) { try{await bot.editMessageText(t,{chat_id:c,message_id:m,parse_mode:'HTML',...o});}catch(_){} }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.onText(/\/start/, async (msg) => {
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  if (!isAuth(userId)) {
    h.setAdminState(userId,'awaiting_password');
    return send(chatId,`🔐 <b>Welcome to NEXVAULT SHOP Admin Panel</b>\n\nEnter admin password:`);
  }
  _auth.add(userId);
  showPanel(chatId,null,userId);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEXT HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/') && !(msg.text.trim()==='/skip' && h.getAdminState(String(msg.from.id)) && h.getAdminState(String(msg.from.id)).state==='prod_desc')) return;
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  const state=h.getAdminState(userId);

  if (state && state.state==='awaiting_password') {
    if (msg.text.trim()===PASSWORD) { _auth.add(userId); h.clearAdminState(userId); return showPanel(chatId,null,userId); }
    return send(chatId,`❌ Wrong password. Try again:`);
  }
  if (!isAuth(userId)) return;
  if (!state) return;

  const t=msg.text; const d=state.data||{};
  switch(state.state) {
    case 'join_url':      return handleJoinUrl(chatId,userId,t,d);
    case 'join_name':     return handleJoinName(chatId,userId,t,d);
    case 'prod_name':     return handleProd(chatId,userId,'name',t,d);
    case 'prod_price':    return handleProd(chatId,userId,'price',t,d);
    case 'prod_stock':    return handleProd(chatId,userId,'stock',t,d);
    case 'prod_login':    return handleProd(chatId,userId,'login',t,d);
    case 'prod_password': return handleProd(chatId,userId,'password',t,d);
    case 'prod_emoji':    return handleProd(chatId,userId,'emoji',t,d);
    case 'prod_desc':     return handleProd(chatId,userId,'desc',t,d);
    case 'stock_qty':     return handleStockAdd(chatId,userId,'qty',t,d);
    case 'stock_login':   return handleStockAdd(chatId,userId,'login',t,d);
    case 'stock_password':return handleStockAdd(chatId,userId,'password',t,d);
    case 'upi_id':        return handleUpiId(chatId,userId,t,d);
    case 'upi_name':      return handleUpiName(chatId,userId,t,d);
    case 'bin_id':        return handleBinId(chatId,userId,t,d);
    case 'bin_name':      return handleBinName(chatId,userId,t,d);
    case 'support_user':  return handleSupportUser(chatId,userId,t);
    case 'rate':          return handleRate(chatId,userId,t);
    case 'min_dep':       return handleMinDep(chatId,userId,t);
    case 'hire_admin':    return handleHireAdmin(chatId,userId,t);
    case 'broadcast':     return handleBroadcast(chatId,userId,t);
    case 'flash_prod':    return handleFlashProd(chatId,userId,t,d);
    case 'flash_pct':     return handleFlashPct(chatId,userId,t,d);
    case 'flash_hrs':     return handleFlashHrs(chatId,userId,t,d);
    case 'ban_user':      return handleBanUser(chatId,userId,t);
    case 'unban_user':    return handleUnbanUser(chatId,userId,t);
    case 'msg_user':      return handleMsgUser(chatId,userId,t,d);
    case 'password_order': return handlePasswordOrder(chatId,userId,t,d);
    case 'tg_phone':      return handleTgPhone(chatId,userId,t,d);
    case 'tg_code':       return handleTgCode(chatId,userId,t,d);
    case 'tg_2fa':        return handleTg2fa(chatId,userId,t,d);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN PANEL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── GramJS Add TG Number ─────────────────────────────────
const _tgWait = {}; // userId -> { codeResolve, passResolve }

async function handleTgPhone(chatId, userId, text, data) {
  const phone = String(text).replace(/\D/g, '');
  if (phone.length < 10) return send(chatId, 'Invalid phone. Example: +9198xxxxxxxx');
  // prevent double-start spam
  if (_tgWait[userId] && _tgWait[userId].busy) {
    return send(chatId, '⏳ Already connecting this number. Send OTP/2FA if asked, or wait.');
  }
  const productId = data.productId;
  h.setAdminState(userId, 'tg_code', { productId, phone });
  _tgWait[userId] = { busy: true, codeAsked: false, passAsked: false };
  let codeResolve;
  let passResolve;
  const codePromise = new Promise((resolve) => { codeResolve = resolve; _tgWait[userId].codeResolve = resolve; });
  const passPromise = new Promise((resolve) => { passResolve = resolve; _tgWait[userId].passResolve = resolve; });
  await send(chatId, `⏳ Connecting +${phone}...\nWhen Telegram sends the code, <b>type it here</b>.`, { parse_mode: 'HTML' });
  try {
    let twoFaPassword = '';
    const res = await otpManager.createSession(
      phone,
      async () => {
        if (!_tgWait[userId]) _tgWait[userId] = {};
        if (!_tgWait[userId].codeAsked) {
          _tgWait[userId].codeAsked = true;
          await send(chatId, '📨 Send the OTP code now:');
        }
        // if previous resolve already used, create new promise
        if (!_tgWait[userId].codeResolve) {
          await new Promise((r) => {
            _tgWait[userId].codeResolve = r;
          });
        }
        return await new Promise((resolve) => {
          _tgWait[userId].codeResolve = resolve;
        });
      },
      async () => {
        if (!_tgWait[userId]) _tgWait[userId] = {};
        h.setAdminState(userId, 'tg_2fa', { productId, phone });
        if (!_tgWait[userId].passAsked) {
          _tgWait[userId].passAsked = true;
          await send(chatId, '🔐 2FA password required — send it <b>once</b> (saved for buyer):', { parse_mode: 'HTML' });
        }
        return await new Promise((resolve) => {
          _tgWait[userId].passResolve = resolve;
        });
      }
    );
    db.addInventoryItems(productId, [{ id: Date.now() + '_tg', login: phone, password: twoFaPassword, addedAt: Date.now(), extra: 'gramjs_session' }]);
    h.clearAdminState(userId);
    delete _tgWait[userId];
    return send(chatId, `✅ Session saved for +${phone} (${res.name || ''})\nStock +1. Buyers will get auto OTP.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Panel', callback_data: 'adm_panel', style: 'primary' }]] },
    });
  } catch (e) {
    h.clearAdminState(userId);
    delete _tgWait[userId];
    return send(chatId, `❌ ${e.message}`);
  }
}

async function handleTgCode(chatId, userId, text, data) {
  const w = _tgWait[userId];
  if (w && w.codeResolve) {
    w.codeResolve(text.trim());
    w.codeResolve = null;
    return send(chatId, '⏳ Signing in...');
  }
  return send(chatId, 'No pending code request. Start again from Add TG Number.');
}

async function handleTg2fa(chatId, userId, text, data) {
  const w = _tgWait[userId];
  if (w && w.passResolve) {
    w.passResolve(text.trim());
    w.passResolve = null;
    return send(chatId, '⏳ Submitting 2FA...');
  }
  return send(chatId, 'No pending 2FA request.');
}


async function showPanel(chatId,msgId,userId) {
  const text=`⚙️ <b>NEXVAULT SHOP — Admin Panel</b>\n\nChoose an option:`;
  const kb=[
    [{text:'🔗 Change Join URL',callback_data:'adm_join',style:'primary'},{text:'📦 Add Product',callback_data:'adm_add_prod',style:'success'}],
    [{text:'📋 Products',callback_data:'adm_prods',style:'primary'},{text:'💳 Deposit Settings',callback_data:'adm_dep_settings',style:'primary'}],
    [{text:'📥 Pending Deposits',callback_data:'adm_pending_dep',style:'primary'},{text:'🛒 Pending Orders',callback_data:'adm_pending_ord',style:'primary'}],
    [{text:'📱 Add TG Number (OTP)',callback_data:'adm_tg_otp',style:'success'}],
    [{text:'🔀 Feature Toggles',callback_data:'adm_toggles',style:'primary'},{text:'🔥 Flash Sale',callback_data:'adm_flash',style:'primary'}],
    [{text:'📢 Broadcast',callback_data:'adm_broadcast',style:'primary'},{text:'📞 Change Support',callback_data:'adm_support',style:'primary'}],
    [{text:'⚙️ Rate & Min Dep',callback_data:'adm_settings',style:'primary'},{text:'👥 Admins',callback_data:'adm_admins',style:'primary'}],
    [{text:'🚫 Ban / Unban User',callback_data:'adm_ban',style:'danger'}],
  ];
  if (msgId) return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
  return send(chatId,text,{reply_markup:{inline_keyboard:kb}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JOIN URL — FIX: delete option added
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showJoinMenu(chatId,msgId) {
  const links=db.getDb().settings.joinLinks;
  const text=`🔗 <b>Join URL Management</b>\n\n`+
    (links.length?links.map((l,i)=>`${i+1}. ${l.enabled?'🟢':'🔴'} <b>${l.name}</b>\n   ${l.url}`).join('\n\n'):'No links set yet.');
  const kb=[
    ...links.map((l,i)=>[
      {text:`✏️ Edit #${i+1}`,callback_data:`join_edit_${i}`,style:'primary'},
      {text:`${l.enabled?'🔴 Disable':'🟢 Enable'}`,callback_data:`join_toggle_${i}`,style:l.enabled?'danger':'success'},
      {text:`🗑️ Delete`,callback_data:`join_del_${i}`,style:'danger'},
    ]),
    [{text:'➕ Add New Link',callback_data:'join_add',style:'success'}],
    [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}],
  ];
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
}
async function handleJoinUrl(chatId,userId,text,data) {
  const db_=db.getDb();
  if (data.index!==undefined) db_.settings.joinLinks[data.index].url=text.trim();
  else db_.settings.joinLinks.push({name:'New Link',url:text.trim(),enabled:true});
  db.saveDb();
  const idx=data.index!==undefined?data.index:db_.settings.joinLinks.length-1;
  h.setAdminState(userId,'join_name',{index:idx});
  return send(chatId,`✅ URL saved! Now send the display name:`);
}
async function handleJoinName(chatId,userId,text,data) {
  const db_=db.getDb(); db_.settings.joinLinks[data.index].name=text.trim(); db.saveDb();
  h.clearAdminState(userId);
  return send(chatId,`✅ Join link updated!`,{reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel',style:'primary'}]]}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRODUCTS — FIX: add/edit/delete all working
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _draft={};

async function showProds(chatId,msgId,sessionMode=false) {
  const rate=db.getDb().settings.usdtToInrRate||90;
  const prods=db.listProducts(sessionMode);
  const title=sessionMode?'📂 Sessions':'📦 Accounts';
  const text=prods.length
    ?`${title}\n\n`+prods.map(p=>{const u=(p.price/rate).toFixed(2);return `${p.emoji||'📦'} ${p.name} | $${u} • ₹${p.price} | Stock: ${p.stock}`;}).join('\n')
    :`${title}\n\nNo products yet.`;
  const kb=[
    [{text:'📦 Accounts',callback_data:'prods_acc',style:'primary'},{text:'📂 Sessions',callback_data:'prods_ses',style:'primary'}],
    ...prods.map(p=>[{text:`${p.emoji||'📦'} ${p.name} — ₹${p.price}`,callback_data:`prod_${p.id}`,style:'primary'}]),
    [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}],
  ];
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
}

async function showProd(chatId,msgId,pid) {
  const p=db.getProduct(pid); if (!p) return;
  const rate=db.getDb().settings.usdtToInrRate||90; const u=(p.price/rate).toFixed(2);
  const text=`${p.emoji||'📦'} <b>${p.name}</b>\n\n💵 $${u} • ₹${p.price}\n📦 Stock: ${p.stock}\n📝 ${p.description||'No description'}\n🏷️ ${p.sessionMode?'Session':'Account'}\n\n🔐 Each stock item contains a separate Email/Number + Password.`;
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:[
    [{text:'➕ Add Stock',callback_data:`stock_add_${pid}`,style:'success'}],
    [{text:'✏️ Edit',callback_data:`prod_edit_${pid}`,style:'primary'},{text:'🗑️ Delete',callback_data:`prod_del_${pid}`,style:'danger'}],
    [{text:'🔙 Back',callback_data:'adm_prods',style:'primary'}],
  ]}});
}

async function startAddProd(chatId,userId,sessionMode=false) {
  _draft[userId]={sessionMode:sessionMode,inventory:[]};
  h.setAdminState(userId,'prod_name',{sessionMode:sessionMode});
  return send(chatId,`📦 <b>Add Product</b>\n\nStep 1/6 — Enter product name:`);
}

async function handleProd(chatId,userId,field,text,data) {
  const d=_draft[userId]||{};
  if (field==='name') {
    d.name=text.trim(); _draft[userId]=d; h.setAdminState(userId,'prod_price',data);
    return send(chatId,data && data.editId ? `Step 2/4 — New price in ₹:` : `Step 2/6 — Price in ₹:`);
  }
  if (field==='price') {
    const price=parseFloat(text); if (isNaN(price)||price<=0) return send(chatId,`❌ Invalid price. Enter a positive number:`);
    d.price=price; _draft[userId]=d;
    if (data && data.editId) {
      h.setAdminState(userId,'prod_emoji',data);
      return send(chatId,`Step 3/4 — New emoji (send /skip to keep current):`);
    }
    h.setAdminState(userId,'prod_stock',data);
    return send(chatId,`Step 3/6 — How many stock accounts/items?\n\nExample: <code>3</code> means you must enter 3 separate Email/Number + Password pairs.`);
  }
  if (field==='stock') {
    const qty=parseInt(text,10);
    if (isNaN(qty)||qty<0) return send(chatId,`❌ Invalid quantity. Enter 0 or a positive whole number:`);
    d.stockTarget=qty; d.stockIndex=1; d.inventory=[]; _draft[userId]=d;
    if (qty===0) {
      h.setAdminState(userId,'prod_emoji',data);
      return send(chatId,`Step 4/6 — Emoji (e.g. 🇮🇳):`);
    }
    h.setAdminState(userId,'prod_login',data);
    return send(chatId,`🔐 <b>Stock item 1/${qty}</b>\n\nEnter Email / Number:`);
  }
  if (field==='login') {
    if (!text.trim()) return send(chatId,`❌ Email/Number cannot be empty. Enter it again:`);
    d.currentLogin=text.trim(); _draft[userId]=d; h.setAdminState(userId,'prod_password',data);
    return send(chatId,`🔑 Stock item ${d.stockIndex}/${d.stockTarget}\n\nEnter Password:`);
  }
  if (field==='password') {
    if (!text) return send(chatId,`❌ Password cannot be empty. Enter it again:`);
    d.inventory.push({id:String(Date.now())+'_'+d.stockIndex,login:d.currentLogin,password:text,addedAt:Date.now()});
    d.currentLogin=null;
    if (d.stockIndex < d.stockTarget) {
      d.stockIndex += 1; _draft[userId]=d; h.setAdminState(userId,'prod_login',data);
      return send(chatId,`🔐 <b>Stock item ${d.stockIndex}/${d.stockTarget}</b>\n\nEnter Email / Number:`);
    }
    _draft[userId]=d; h.setAdminState(userId,'prod_emoji',data);
    return send(chatId,`Step 4/6 — All ${d.stockTarget} stock items saved.\n\nEnter Emoji (e.g. 🇮🇳):`);
  }
  if (field==='emoji') {
    if (!(data && data.editId)) {
      d.emoji=text.trim(); _draft[userId]=d; h.setAdminState(userId,'prod_desc',data);
      return send(chatId,`Step 5/6 — Description (or /skip):`);
    }
    if (text.trim()!=='/skip') d.emoji=text.trim();
    _draft[userId]=d; h.setAdminState(userId,'prod_desc',data);
    return send(chatId,`Step 4/4 — New description (or /skip to keep current):`);
  }
  if (field==='desc') {
    if (data && data.editId) {
      if (text.trim()!=='/skip') d.description=text.trim();
      const ok=db.updateProduct(data.editId,{name:d.name,price:d.price,emoji:d.emoji,description:d.description});
      const prod=db.getProduct(data.editId);
      delete _draft[userId]; h.clearAdminState(userId);
      return send(chatId,ok?`✅ <b>Product updated!</b>\n\n${prod.emoji||'📦'} ${prod.name}\n₹${prod.price}\n📦 Stock: ${prod.stock}`:`❌ Product update failed.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Products',callback_data:'adm_prods',style:'primary'}]]}});
    }
    d.description=text.trim()==='/skip'?null:text.trim();
    const prodData={name:d.name,price:d.price,emoji:d.emoji,description:d.description,sessionMode:!!d.sessionMode,inventory:d.inventory||[]};
    const prod=db.addProduct(prodData);
    delete _draft[userId]; h.clearAdminState(userId);
    const rate=db.getDb().settings.usdtToInrRate||90;
    return send(chatId,`✅ <b>Product added!</b>\n\n${prod.emoji||'📦'} ${prod.name}\n$${(prod.price/rate).toFixed(2)} • ₹${prod.price}\n📦 Stock: ${prod.stock}\n🔐 Credentials stored: ${prod.stock}`,
      {reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel',style:'primary'}]]}});
  }
}

async function handleStockAdd(chatId,userId,field,text,data) {
  const d=_draft[userId]||{};
  if (field==='qty') {
    const qty=parseInt(text,10);
    if (isNaN(qty)||qty<1) return send(chatId,`❌ Enter a stock quantity of at least 1:`);
    d.stockTarget=qty; d.stockIndex=1; d.inventory=[]; _draft[userId]=d;
    h.setAdminState(userId,'stock_login',data);
    return send(chatId,`🔐 <b>New stock item 1/${qty}</b>\n\nEnter Email / Number:`);
  }
  if (field==='login') {
    if (!text.trim()) return send(chatId,`❌ Email/Number cannot be empty:`);
    d.currentLogin=text.trim(); _draft[userId]=d; h.setAdminState(userId,'stock_password',data);
    return send(chatId,`🔑 New stock item ${d.stockIndex}/${d.stockTarget}\n\nEnter Password:`);
  }
  if (field==='password') {
    if (!text) return send(chatId,`❌ Password cannot be empty:`);
    d.inventory.push({id:String(Date.now())+'_'+d.stockIndex,login:d.currentLogin,password:text,addedAt:Date.now()});
    if (d.stockIndex < d.stockTarget) {
      d.stockIndex += 1; _draft[userId]=d; h.setAdminState(userId,'stock_login',data);
      return send(chatId,`🔐 <b>New stock item ${d.stockIndex}/${d.stockTarget}</b>\n\nEnter Email / Number:`);
    }
    const ok=db.addInventoryItems(d.productId,d.inventory);
    delete _draft[userId]; h.clearAdminState(userId);
    const product=db.getProduct(d.productId);
    return send(chatId,ok?`✅ <b>Stock added successfully!</b>\n\n📦 ${product.name}\n➕ Added: ${d.stockTarget}\n📊 Total stock: ${product.stock}`:`❌ Could not add stock.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Products',callback_data:'adm_prods',style:'primary'}]]}});
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEPOSIT SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showDepSettings(chatId,msgId) {
  const pay=db.getDb().settings.payments;
  return edit(chatId,msgId,`💳 <b>Deposit Settings</b>\n\nSelect payment method:`,{reply_markup:{inline_keyboard:[
    [{text:`📱 G Pay ${pay.gpay.enabled?'🟢':'🔴'}`,callback_data:'pay_gpay',style:pay.gpay.enabled?'success':'danger'},{text:`💳 Fam Pay ${pay.fampay.enabled?'🟢':'🔴'}`,callback_data:'pay_fampay',style:pay.fampay.enabled?'success':'danger'}],
    [{text:`🗃️ Any UPI ${pay.anyupi.enabled?'🟢':'🔴'}`,callback_data:'pay_anyupi',style:pay.anyupi.enabled?'success':'danger'},{text:`🏦 Binance ${pay.binance.enabled?'🟢':'🔴'}`,callback_data:'pay_binance',style:pay.binance.enabled?'success':'danger'}],
    [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}],
  ]}});
}

async function showPayMethod(chatId,msgId,method) {
  const pay=db.getDb().settings.payments[method];
  const names={gpay:'G Pay',fampay:'Fam Pay',anyupi:'Any UPI',binance:'Binance Pay'};
  const isBin=method==='binance';
  const text=`💳 <b>${names[method]} Settings</b>\n\nStatus: ${pay.enabled?'🟢 Enabled':'🔴 Disabled'}\n`+
    (isBin?`🆔 ID: ${pay.binanceId||'Not set'}\n👤 Name: ${pay.binanceName||'Not set'}`
          :`🆔 UPI ID: ${pay.upiId||'Not set'}\n👤 Name: ${pay.upiName||'Not set'}\n🖼️ QR: ${pay.qrFileId?'✅ Set':'❌ Not set'}`);
  const kb=[];
  if (!isBin) {
    kb.push([{text:'🖼️ Change QR',callback_data:`qr_${method}`,style:'primary'},{text:'🆔 Change ID/Name',callback_data:`uid_${method}`,style:'primary'}]);
    kb.push([{text:'🗑️ Delete QR/ID',callback_data:`pdel_${method}`,style:'danger'}]);
  } else {
    kb.push([{text:'🆔 Change Binance ID/Name',callback_data:`bid_binance`,style:'primary'}]);
    kb.push([{text:'🗑️ Delete Binance ID',callback_data:`pdel_binance`,style:'danger'}]);
  }
  kb.push([{text:`${pay.enabled?'🔴 Disable':'🟢 Enable'}`,callback_data:`ptog_${method}`,style:pay.enabled?'danger':'success'}]);
  kb.push([{text:'🔙 Back',callback_data:'adm_dep_settings',style:'primary'}]);
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
}

// QR Upload (Admin→User relay + permanent storage)
async function handleQrUpload(chatId,userId,method,adminFileId) {
  await send(chatId,`⏳ Uploading QR permanently, please wait...`);
  const result = await h.mintUserBotFileId(adminFileId);
  const db_    = db.getDb();
  if (result && result.userFileId) {
    // Save BOTH permanently stored file_ids (from STORAGE_CHAT_ID)
    // These never expire because they're anchored to a real message
    db_.settings.payments[method].qrFileId      = result.userFileId;
    db_.settings.payments[method].qrFileIdAdmin = result.adminFileIdStored;
    db.saveDb();
    return send(chatId,
      `✅ QR saved permanently!\n\n🗄️ Stored in your storage chat — will never expire.\n✅ Both bots have valid copies.`,
      {reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:`pay_${method}`,style:'primary'}]]}}
    );
  } else {
    db_.settings.payments[method].qrFileIdAdmin=adminFileId; db.saveDb();
    return send(chatId,`⚠️ Admin copy saved, but User Bot relay failed.\nCheck BOT_TOKEN & Owner must /start the User Bot first.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:`pay_${method}`,style:'primary'}]]}});
  }
}

async function handleUpiId(chatId,userId,text,data)   { db.getDb().settings.payments[data.method].upiId=text.trim(); db.saveDb(); h.setAdminState(userId,'upi_name',data); return send(chatId,`✅ UPI ID saved! Now enter display name:`); }
async function handleUpiName(chatId,userId,text,data)  { db.getDb().settings.payments[data.method].upiName=text.trim(); db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ UPI ID & Name updated!`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:`pay_${data.method}`,style:'primary'}]]}}); }
async function handleBinId(chatId,userId,text,data)    { db.getDb().settings.payments.binance.binanceId=text.trim(); db.saveDb(); h.setAdminState(userId,'bin_name',data); return send(chatId,`✅ Binance ID saved! Enter display name:`); }
async function handleBinName(chatId,userId,text,data)  { db.getDb().settings.payments.binance.binanceName=text.trim(); db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ Binance ID & Name updated!`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'pay_binance',style:'primary'}]]}}); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PENDING DEPOSITS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showPendingDep(chatId,msgId) {
  const pend=db.getPendingDeposits();
  if (!pend.length) return edit(chatId,msgId,`📥 <b>No Pending Deposits</b>`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}]]}});
  const text=`📥 <b>Pending Deposits</b> (${pend.length})`;
  const kb=[...pend.map(d=>{const u=db.getUser(d.userId); return [{text:`#${d.id} — ${u.username?'@'+u.username:d.userId} — ₹${d.amount}`,callback_data:`dep_view_${d.id}`,style:'primary'}];}), [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}]];
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:kb}});
}

async function showDepDetail(chatId,msgId,did) {
  const dep=db.getDeposit(did); if (!dep) return send(chatId,`❌ Not found.`);
  const user=db.getUser(dep.userId); const rate=db.getDb().settings.usdtToInrRate||90; const usd=(dep.amount/rate).toFixed(2);
  const cap=
    `💰 <b>Deposit #${did}</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
    `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n`+
    `🆔 ID: <code>${dep.userId}</code>\n`+
    `💵 ₹${dep.amount} ($${usd})\n`+
    `💳 Method: ${(dep.method ? dep.method.toUpperCase() : '')}\n`+
    `💼 Balance: ₹${user.balance.toFixed(2)}\n`+
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n`+
    `🔁 Deposits: ${user.depositCount}\n`+
    `📅 ${new Date(dep.createdAt).toLocaleString('en-IN')}`;
  const kb={inline_keyboard:[
    [{text:'✅ Approve',callback_data:`dep_ok_${did}`,style:'success'},{text:'❌ Reject',callback_data:`dep_no_${did}`,style:'danger'}],
    [{text:'✉️ Message User',callback_data:`msg_${dep.userId}`,style:'primary'}],
    [{text:'🔙 Back',callback_data:'adm_pending_dep',style:'primary'}],
  ]};
  const fileId=dep.screenshotFileIdAdmin||dep.screenshotFileId;
  if (fileId) {
    try{await bot.deleteMessage(chatId,msgId);}catch(_){}
    await bot.sendPhoto(chatId,fileId,{caption:cap,parse_mode:'HTML',reply_markup:kb});
  } else {
    await edit(chatId,msgId,cap,{reply_markup:kb});
  }
}

async function approveDeposit(chatId,msgId,did) {
  const dep=db.getDeposit(did); if (!dep||dep.status!=='pending') return send(chatId,`❌ Not found or already processed.`);
  db.updateDeposit(did,{status:'approved',approvedAt:Date.now()});
  const user=db.getUser(dep.userId);
  db.updateUser(dep.userId,{balance:user.balance+dep.amount,totalDeposited:user.totalDeposited+dep.amount,depositCount:user.depositCount+1});
  const updatedUser=db.getUser(dep.userId);
  const rate=db.getDb().settings.usdtToInrRate||90;
  const usd=(dep.amount/rate).toFixed(2);

  // Tell admin
  await send(chatId,`✅ Deposit #${did} Approved! ₹${dep.amount} added.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Pending',callback_data:'adm_pending_dep',style:'primary'}]]}});

  // FIX 2: Also send approval log to STORAGE_CHAT_ID channel
  const storageChatId=process.env.STORAGE_CHAT_ID;
  if (storageChatId) {
    try {
      await bot.sendMessage(storageChatId,
        `✅ <b>DEPOSIT APPROVED</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
        `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n`+
        `🆔 ID: <code>${dep.userId}</code>\n`+
        `💵 Amount: ₹${dep.amount} ($${usd})\n`+
        `💳 Method: ${(dep.method ? dep.method.toUpperCase() : '')}\n`+
        `💰 New Balance: ₹${updatedUser.balance.toFixed(2)}\n`+
        `📋 Deposit ID: #${did}\n`+
        `📅 ${new Date().toLocaleString('en-IN')}`,
        {parse_mode:'HTML'}
      );
    } catch(_){}
  }

  // Public support group feed
  if (SUPPORT_GROUP) {
    try {
      const uname = user.username ? '@' + user.username : (user.firstName || 'User');
      await bot.sendMessage(SUPPORT_GROUP,
        `💰 <b>New Deposit</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `👤 User: ${uname}\n` +
        `🆔 ID: <code>${dep.userId}</code>\n` +
        `💵 Amount: <b>₹${dep.amount}</b>\n` +
        `💳 Method: ${(dep.method || 'manual').toUpperCase()}\n` +
        `📋 #${did}\n` +
        `🕐 ${new Date().toLocaleString('en-IN')}`,
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch (e) { console.error('[support group]', e.message); }
  }

  // FIX 1: Notify user via User Bot (not Telegram DM)
  try{await U.notifyDepositApproved(dep.userId,dep);}catch(_){}
}

async function rejectDeposit(chatId,msgId,did) {
  const dep=db.getDeposit(did); if (!dep||dep.status!=='pending') return send(chatId,`❌ Not found or already processed.`);
  db.updateDeposit(did,{status:'rejected',rejectedAt:Date.now()});
  const user=db.getUser(dep.userId);
  const rate=db.getDb().settings.usdtToInrRate||90;
  const usd=(dep.amount/rate).toFixed(2);

  // Tell admin
  await send(chatId,`❌ Deposit #${did} Rejected.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Pending',callback_data:'adm_pending_dep',style:'primary'}]]}});

  // FIX 2: Also send rejection log to STORAGE_CHAT_ID channel
  const storageChatId=process.env.STORAGE_CHAT_ID;
  if (storageChatId) {
    try {
      await bot.sendMessage(storageChatId,
        `❌ <b>DEPOSIT REJECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
        `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n`+
        `🆔 ID: <code>${dep.userId}</code>\n`+
        `💵 Amount: ₹${dep.amount} ($${usd})\n`+
        `💳 Method: ${(dep.method ? dep.method.toUpperCase() : '')}\n`+
        `📋 Deposit ID: #${did}\n`+
        `📅 ${new Date().toLocaleString('en-IN')}`,
        {parse_mode:'HTML'}
      );
    } catch(_){}
  }

  // FIX 1: Notify user via User Bot (not Telegram DM)
  try{await U.notifyDepositRejected(dep.userId,dep);}catch(_){}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PENDING ORDERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showPendingOrd(chatId,msgId) {
  const ords=db.getPendingOrders();
  if (!ords.length) return edit(chatId,msgId,`🛒 <b>No Pending Orders</b>`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}]]}});
  const kb=[...ords.map(o=>{const u=db.getUser(o.userId);const p=db.getProduct(o.productId);return [{text:`#${o.id} — ${u.username?'@'+u.username:o.userId} — ${(p && p.name)||'?'}`,callback_data:`ord_${o.id}`,style:'primary'}];}),
    [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}]];
  return edit(chatId,msgId,`🛒 <b>Pending Orders</b> (${ords.length})`,{reply_markup:{inline_keyboard:kb}});
}

async function showOrdDetail(chatId,msgId,oid) {
  const ord=db.getOrder(oid); if (!ord) return;
  const user=db.getUser(ord.userId); const p=db.getProduct(ord.productId); const rate=db.getDb().settings.usdtToInrRate||90;
  const text=
    `🛒 <b>Order #${oid}</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
    `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n`+
    `🆔 ID: <code>${ord.userId}</code>\n`+
    `📦 Product: ${(p && p.emoji)||''} ${(p && p.name)||'Unknown'}\n`+
    `💰 Price: ₹${ord.totalPrice} ($${(ord.totalPrice/rate).toFixed(2)})\n`+
    `💼 Balance: ${h.formatBalance(user.balance)}\n`+
    `📅 ${new Date(ord.createdAt).toLocaleString('en-IN')}`;
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:[
    [{text:'✅ Mark Delivered',callback_data:`deliver_${oid}`,style:'success'},{text:'✉️ Message User',callback_data:`msg_${ord.userId}`,style:'primary'}],
    [{text:'🔙 Back',callback_data:'adm_pending_ord',style:'primary'}],
  ]}});
}

async function deliverOrder(chatId,msgId,oid) {
  const ord=db.getOrder(oid); if (!ord) return;
  db.updateOrder(oid,{status:'delivered',deliveredAt:Date.now()});
  await send(chatId,`✅ Order #${oid} marked as delivered!`,{reply_markup:{inline_keyboard:[[{text:'🔙 Orders',callback_data:'adm_pending_ord',style:'primary'}]]}});
  try{await U.notifyOrderDelivered(ord.userId,ord);}catch(_){}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FEATURE TOGGLES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showToggles(chatId,msgId) {
  const f=db.getDb().settings.features;
  const btn=(lbl,key)=>({text:`${f[key]?'🟢':'🔴'} ${lbl}`,callback_data:`tog_${key}`,style:f[key]?'success':'danger'});
  return edit(chatId,msgId,`🔀 <b>Feature Toggles</b>`,{reply_markup:{inline_keyboard:[
    [btn('Buy Account','buyAccount'),btn('Buy Sessions','buySession')],
    [btn('Deposit','deposit'),btn('Refer & Earn','referEarn')],
    [btn('Support','support'),btn('Leaderboard','leaderboard')],
    [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}],
  ]}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FLASH SALE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showFlash(chatId,msgId) {
  const fs=db.getDb().settings.flashSale;
  const text=fs.active?`🔥 <b>Flash Sale ACTIVE</b>\n\nProduct: ${fs.productId}\nDiscount: ${fs.discountPercent}%\nEnds: ${new Date(fs.endsAt).toLocaleString('en-IN')}`:`🔥 <b>Flash Sale</b>\n\nNo active flash sale.`;
  return edit(chatId,msgId,text,{reply_markup:{inline_keyboard:[
    [{text:fs.active?'🛑 Stop':'🔥 Start Flash Sale',callback_data:fs.active?'flash_stop':'flash_start',style:fs.active?'danger':'success'}],
    [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}],
  ]}});
}
async function handleFlashProd(chatId,userId,text,data) { const p=db.getProduct(text.trim()); if (!p) return send(chatId,`❌ Product ID not found:`); _draft[userId]={productId:text.trim()}; h.setAdminState(userId,'flash_pct',data); return send(chatId,`Enter discount % (e.g. 20):`); }
async function handleFlashPct(chatId,userId,text,data)  { const pct=parseInt(text); if (isNaN(pct)||pct<1||pct>99) return send(chatId,`❌ Enter 1-99:`); _draft[userId]={..._draft[userId],discountPercent:pct}; h.setAdminState(userId,'flash_hrs',data); return send(chatId,`For how many hours?`); }
async function handleFlashHrs(chatId,userId,text,data)  {
  const hrs=parseFloat(text); if (isNaN(hrs)||hrs<=0) return send(chatId,`❌ Invalid hours:`);
  const d=_draft[userId]||{}; const db_=db.getDb();
  db_.settings.flashSale={active:true,productId:d.productId,discountPercent:d.discountPercent,endsAt:Date.now()+hrs*3600000};
  db.updateProduct(d.productId,{flashSale:true}); db.saveDb();
  delete _draft[userId]; h.clearAdminState(userId);
  return send(chatId,`🔥 Flash Sale started! ${d.discountPercent}% off for ${hrs}h.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel',style:'primary'}]]}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BROADCAST
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleBroadcast(chatId,userId,text) {
  h.clearAdminState(userId);
  const users=Object.values(db.getDb().users); let sent=0,failed=0;
  await send(chatId,`📢 Sending to ${users.length} users...`);
  for (const u of users) {
    try { await U.bot.sendMessage(u.userId,`📢 <b>Announcement</b>\n\n${text}`,{parse_mode:'HTML'}); sent++; }
    catch(_){failed++;}
    await new Promise(r=>setTimeout(r,50));
  }
  return send(chatId,`✅ Done! Sent: ${sent} | Failed: ${failed}`,{reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel',style:'primary'}]]}});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showSettings(chatId,msgId) {
  const db_=db.getDb();
  return edit(chatId,msgId,`⚙️ <b>Settings</b>\n\n💱 Rate: 1 USDT = ₹${db_.settings.usdtToInrRate}\n💵 Min Deposit: ₹${db_.settings.minDepositInr}`,
    {reply_markup:{inline_keyboard:[[{text:'💱 Change Rate',callback_data:'set_rate',style:'primary'},{text:'💵 Change Min',callback_data:'set_min',style:'primary'}],[{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}]]}});
}
async function handleSupportUser(chatId,userId,text) { db.getDb().settings.supportUsername=text.trim().replace('@',''); db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ Support updated to @${text.trim().replace('@','')}`,{reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel',style:'primary'}]]}}); }
async function handleRate(chatId,userId,text) { const r=parseFloat(text); if (isNaN(r)||r<=0) return send(chatId,`❌ Invalid:`); db.getDb().settings.usdtToInrRate=r; db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ Rate: 1 USDT = ₹${r}`,{reply_markup:{inline_keyboard:[[{text:'🔙 Settings',callback_data:'adm_settings',style:'primary'}]]}}); }
async function handleMinDep(chatId,userId,text) { const m=parseFloat(text); if (isNaN(m)||m<=0) return send(chatId,`❌ Invalid:`); db.getDb().settings.minDepositInr=m; db.saveDb(); h.clearAdminState(userId); return send(chatId,`✅ Min deposit: ₹${m}`,{reply_markup:{inline_keyboard:[[{text:'🔙 Settings',callback_data:'adm_settings',style:'primary'}]]}}); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMINS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showAdmins(chatId,msgId) {
  const admins=db.listAdmins();
  return edit(chatId,msgId,`👥 <b>Hired Admins</b>\n\n`+(admins.length?admins.map(a=>`• <code>${a.userId}</code>`).join('\n'):'None'),
    {reply_markup:{inline_keyboard:[
      [{text:'➕ Hire Admin',callback_data:'hire_admin',style:'success'}],
      ...admins.map(a=>[{text:`🗑️ Remove ${a.userId}`,callback_data:`fire_${a.userId}`,style:'danger'}]),
      [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}],
    ]}});
}
async function handleHireAdmin(chatId,userId,text) { const tid=text.trim(); if (tid===OWNER_ID) return send(chatId,`❌ Owner already authorized.`); db.addAdmin(tid,userId); h.clearAdminState(userId); return send(chatId,`✅ Admin <code>${tid}</code> hired!`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔙 Admins',callback_data:'adm_admins',style:'primary'}]]}}); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PASSWORD DELIVERY REQUESTS
// Buyer presses Fetch Password -> admin receives request -> admin types password
// The password is sent ONLY to the order's buyer through the User Bot.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handlePasswordOrder(chatId,userId,text,data) {
  const oid = data && data.orderId;
  const ord = db.getOrder(oid);
  if (!ord) { h.clearAdminState(userId); return send(chatId,`❌ Order #${oid} not found.`); }
  if (!text || !text.trim()) return send(chatId,`❌ Password cannot be empty. Enter the password again:`);
  const targetId = String(ord.userId);
  const p = db.getProduct(ord.productId);
  const password = text.trim();
  try {
    await U.bot.sendMessage(targetId,
      `🔐 <b>Password Received</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
      `📦 ${p ? (p.emoji || '📦')+' '+p.name : 'Your order'}\n` +
      `🧾 Order: <code>#${oid}</code>\n\n` +
      `🔑 <b>Password:</b> <code>${password.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}</code>\n\n` +
      `⚠️ Keep this password private.`,
      {parse_mode:'HTML'}
    );
    db.updateOrder(oid,{lastPasswordSentAt:Date.now(),passwordRequestFulfilled:(Number(ord.passwordRequestFulfilled||0)+1)});
    h.clearAdminState(userId);
    return send(chatId,
      `✅ <b>Password sent successfully.</b>\n\nOrder: #${oid}\nUser ID: <code>${targetId}</code>\n\nThe password was delivered only to that buyer via User Bot.`,
      {reply_markup:{inline_keyboard:[[{text:'🔙 Pending Orders',callback_data:'adm_pending_ord',style:'primary'}]]}}
    );
  } catch (e) {
    return send(chatId,`❌ Failed to send password.\n\nError: ${h.escapeHtml ? h.escapeHtml(e.message) : e.message}`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN → USER MESSAGING SYSTEM
// Admin message likhta hai → User Bot se user ko deliver
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleMsgUser(chatId, userId, text, data) {
  const targetId = data.targetUserId;
  const user     = db.getUser(targetId);

  h.clearAdminState(userId);

  try {
    // Deliver via User Bot so it appears from the store bot
    await U.bot.sendMessage(targetId,
      `📩 <b>Message from Admin</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${text}`,
      { parse_mode: 'HTML' }
    );
    return send(chatId,
      `✅ Message delivered to ${user.username ? '@'+user.username : targetId} via User Bot!`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✉️ Send Another', callback_data: `msg_${targetId}`, style: 'primary' }],
        [{ text: '🔙 Panel', callback_data: 'adm_panel', style: 'primary' }],
      ]}}
    );
  } catch (err) {
    return send(chatId,
      `❌ Failed to deliver message.\nUser may have blocked the bot.\n\nError: ${err.message}`,
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Panel', callback_data: 'adm_panel', style: 'primary' }]] }}
    );
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BAN / UNBAN SYSTEM — NEW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showBanMenu(chatId,msgId) {
  return edit(chatId,msgId,`🚫 <b>Ban / Unban System</b>\n\nEnter user ID to ban or unban:`,
    {reply_markup:{inline_keyboard:[
      [{text:'🚫 Ban User',callback_data:'do_ban',style:'danger'},{text:'✅ Unban User',callback_data:'do_unban',style:'success'}],
      [{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}],
    ]}});
}
async function handleBanUser(chatId,userId,text) { const tid=text.trim(); db.banUser(tid); h.clearAdminState(userId); return send(chatId,`🚫 User <code>${tid}</code> banned.`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel',style:'primary'}]]}}); }
async function handleUnbanUser(chatId,userId,text) { const tid=text.trim(); db.unbanUser(tid); h.clearAdminState(userId); return send(chatId,`✅ User <code>${tid}</code> unbanned.`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔙 Panel',callback_data:'adm_panel',style:'primary'}]]}}); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHOTO HANDLER — QR uploads
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('photo', async (msg) => {
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  if (!isAuth(userId)) return;
  const state=h.getAdminState(userId);
  if (!state||state.state!=='awaiting_qr') return;
  const fileId=msg.photo[msg.photo.length-1].file_id;
  h.clearAdminState(userId);
  await handleQrUpload(chatId,userId,state.data.method,fileId);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CALLBACK ROUTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('callback_query', async (q) => {
  if (isDupe(q.id)) return;
  const chatId=q.message && q.message.chat ? q.message.chat.id : q.from.id;
  const msgId=q.message ? q.message.message_id : null;
  const userId=String(q.from.id); const data=q.data || '';
  try {
  if (!isAuth(userId)) return;

  if (data==='adm_panel')        return showPanel(chatId,msgId,userId);
  if (data==='adm_join')         return showJoinMenu(chatId,msgId);
  if (data==='join_add')         { h.setAdminState(userId,'join_url',{}); return edit(chatId,msgId,`Enter the join URL:`); }
  if (data.startsWith('join_edit_'))   { const i=parseInt(data.replace('join_edit_','')); h.setAdminState(userId,'join_url',{index:i}); return edit(chatId,msgId,`Enter new URL for link #${i+1}:`); }
  if (data.startsWith('join_toggle_')) { const i=parseInt(data.replace('join_toggle_','')); const db_=db.getDb(); db_.settings.joinLinks[i].enabled=!db_.settings.joinLinks[i].enabled; db.saveDb(); return showJoinMenu(chatId,msgId); }
  if (data.startsWith('join_del_'))    { const i=parseInt(data.replace('join_del_','')); db.getDb().settings.joinLinks.splice(i,1); db.saveDb(); return showJoinMenu(chatId,msgId); }

  if (data==='adm_prods')        return showProds(chatId,msgId,false);
  if (data==='prods_acc')        return showProds(chatId,msgId,false);
  if (data==='prods_ses')        return showProds(chatId,msgId,true);
  if (data==='adm_tg_otp') {
    if (!otpManager.ready()) return safeAnswer(q,{text:'Set API_ID and API_HASH in .env',show_alert:true});
    const prods = db.listProducts(false);
    if (!prods.length) return safeAnswer(q,{text:'Create an Account product first',show_alert:true});
    const kb = prods.map(p=>[{text:`${p.emoji||'📦'} ${p.name} (${p.stock})`,callback_data:`tg_prod_${p.id}`,style:'success'}]);
    kb.push([{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}]);
    return edit(chatId,msgId,`📱 <b>Add TG Number (Auto OTP)</b>\n\nSelect product, then send phone + OTP. Session is saved.`,{reply_markup:{inline_keyboard:kb}});
  }
  if (data.startsWith('tg_prod_')) {
    const pid = data.replace('tg_prod_','');
    h.setAdminState(userId,'tg_phone',{productId:pid});
    return edit(chatId,msgId,`📱 Send phone with country code:\n<code>+9198xxxxxxxx</code>`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'❌ Cancel',callback_data:'adm_panel',style:'danger'}]]}});
  }
  if (data==='adm_add_prod')     return startAddProd(chatId,userId,false);
  if (data==='adm_add_ses')      return startAddProd(chatId,userId,true);
  if (data.startsWith('prod_edit_')) { const pid=data.replace('prod_edit_',''); const pp=db.getProduct(pid)||{}; _draft[userId]={...pp,inventory:pp.inventory||[]}; h.setAdminState(userId,'prod_name',{editId:pid}); return send(chatId,`Editing product.\nStep 1/4 — New name:`); }
  if (data.startsWith('stock_add_')) { const pid=data.replace('stock_add_',''); if (!db.getProduct(pid)) return; _draft[userId]={productId:pid,inventory:[]}; h.setAdminState(userId,'stock_qty',{}); return edit(chatId,msgId,`➕ <b>Add Stock</b>\n\nHow many new Email/Number + Password pairs do you want to add?`); }
  if (data.startsWith('prod_del_'))  { db.deleteProduct(data.replace('prod_del_','')); return edit(chatId,msgId,`🗑️ Deleted.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'adm_prods',style:'primary'}]]}}); }
  if (data.startsWith('prod_'))      return showProd(chatId,msgId,data.replace('prod_',''));

  if (data==='adm_dep_settings') return showDepSettings(chatId,msgId);
  if (data==='pay_gpay')         return showPayMethod(chatId,msgId,'gpay');
  if (data==='pay_fampay')       return showPayMethod(chatId,msgId,'fampay');
  if (data==='pay_anyupi')       return showPayMethod(chatId,msgId,'anyupi');
  if (data==='pay_binance')      return showPayMethod(chatId,msgId,'binance');
  if (data.startsWith('qr_'))    { const m=data.replace('qr_',''); h.setAdminState(userId,'awaiting_qr',{method:m}); return edit(chatId,msgId,`🖼️ Upload your new QR image now:`); }
  if (data.startsWith('uid_'))   { const m=data.replace('uid_',''); h.setAdminState(userId,'upi_id',{method:m}); return edit(chatId,msgId,`Enter new UPI ID:`); }
  if (data==='bid_binance')      { h.setAdminState(userId,'bin_id',{}); return edit(chatId,msgId,`Enter new Binance ID:`); }
  if (data.startsWith('pdel_'))  { const m=data.replace('pdel_',''); const db_=db.getDb(); Object.assign(db_.settings.payments[m],{qrFileId:null,qrFileIdAdmin:null,upiId:null,upiName:null,binanceId:null,binanceName:null}); db.saveDb(); return send(chatId,`🗑️ Cleared.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:`pay_${m}`,style:'primary'}]]}}); }
  if (data.startsWith('ptog_'))  { const m=data.replace('ptog_',''); const db_=db.getDb(); db_.settings.payments[m].enabled=!db_.settings.payments[m].enabled; db.saveDb(); return showPayMethod(chatId,msgId,m); }

  if (data==='adm_pending_dep')  return showPendingDep(chatId,msgId);
  if (data.startsWith('dep_view_')) return showDepDetail(chatId,msgId,data.replace('dep_view_',''));
  if (data.startsWith('dep_ok_'))  return approveDeposit(chatId,msgId,data.replace('dep_ok_',''));
  if (data.startsWith('dep_no_'))  return rejectDeposit(chatId,msgId,data.replace('dep_no_',''));

  if (data==='adm_pending_ord')  return showPendingOrd(chatId,msgId);
  if (data.startsWith('ord_'))   return showOrdDetail(chatId,msgId,data.replace('ord_',''));
  if (data.startsWith('send_password_')) {
    return safeAnswer(q,{text:'Manual OTP disabled. Auto OTP is used.',show_alert:true});
    const oid=data.replace('send_password_',''); // unreachable

    const ord=db.getOrder(oid);
    if (!ord) return send(chatId,`❌ Order #${oid} not found.`);
    h.setAdminState(userId,'password_order',{orderId:oid});
    return send(chatId,
      `🔐 <b>Enter Password for Order #${oid}</b>\n\n` +
      `👤 User ID: <code>${ord.userId}</code>\n` +
      `📧 Email / Number: <code>${ord.login || ''}</code>\n\n` +
      `Type the password below. It will be sent ONLY to this buyer.`,
      {reply_markup:{inline_keyboard:[[{text:'❌ Cancel',callback_data:'adm_pending_ord',style:'danger'}]]}}
    );
  }
  if (data.startsWith('deliver_')) return deliverOrder(chatId,msgId,data.replace('deliver_',''));

  if (data==='adm_toggles')      return showToggles(chatId,msgId);
  if (data.startsWith('tog_'))   { const k=data.replace('tog_',''); const db_=db.getDb(); db_.settings.features[k]=!db_.settings.features[k]; db.saveDb(); return showToggles(chatId,msgId); }

  if (data==='adm_flash')        return showFlash(chatId,msgId);
  if (data==='flash_start')      { h.setAdminState(userId,'flash_prod',{}); return edit(chatId,msgId,`Enter the Product ID for flash sale:`); }
  if (data==='flash_stop')       { const db_=db.getDb(); if (db_.settings.flashSale.productId) db.updateProduct(db_.settings.flashSale.productId,{flashSale:false}); db_.settings.flashSale={active:false,productId:null,discountPercent:0,endsAt:null}; db.saveDb(); return edit(chatId,msgId,`🛑 Flash Sale stopped.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'adm_panel',style:'primary'}]]}}); }

  if (data==='adm_broadcast')    { h.setAdminState(userId,'broadcast',{}); return edit(chatId,msgId,`📢 Type your broadcast message:`,{reply_markup:{inline_keyboard:[[{text:'❌ Cancel',callback_data:'adm_panel',style:'danger'}]]}}); }
  if (data==='adm_support')      { h.setAdminState(userId,'support_user',{}); return edit(chatId,msgId,`Enter new support username (without @):`); }
  if (data==='adm_settings')     return showSettings(chatId,msgId);
  if (data==='set_rate')         { h.setAdminState(userId,'rate',{}); return edit(chatId,msgId,`Enter new USDT→₹ rate:`); }
  if (data==='set_min')          { h.setAdminState(userId,'min_dep',{}); return edit(chatId,msgId,`Enter new minimum deposit in ₹:`); }

  if (data==='adm_admins')       return showAdmins(chatId,msgId);
  if (data==='hire_admin')       { h.setAdminState(userId,'hire_admin',{}); return edit(chatId,msgId,`Send the Telegram user ID to hire:`); }
  if (data.startsWith('fire_'))  { db.removeAdmin(data.replace('fire_','')); return showAdmins(chatId,msgId); }

  // Admin → User message flow
  if (data.startsWith('msg_')) {
    const targetId = data.replace('msg_','');
    const user     = db.getUser(targetId);
    const name     = user.username ? '@'+user.username : (user.firstName || targetId);
    h.setAdminState(userId, 'msg_user', { targetUserId: targetId });
    return send(chatId,
      `✉️ <b>Message to ${name}</b>\n━━━━━━━━━━━━━━━━━━━━\nType your message below — it will be delivered via User Bot:`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_panel', style: 'danger' }]] }}
    );
  }

  if (data==='adm_ban')          return showBanMenu(chatId,msgId);
  if (data==='do_ban')           { h.setAdminState(userId,'ban_user',{}); return edit(chatId,msgId,`Enter user ID to ban:`); }
  if (data==='do_unban')         { h.setAdminState(userId,'unban_user',{}); return edit(chatId,msgId,`Enter user ID to unban:`); }
  await safeAnswer(q);
  } catch (err) {
    console.error('[admin callback]', err && err.message ? err.message : err);
    try { await safeAnswer(q, { text: 'Error', show_alert: true }); } catch(_){}
  }
});

console.log('⚙️ NEXVAULT SHOP Admin Bot started...');
