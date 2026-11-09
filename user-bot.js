require('dotenv').config();
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// user-bot.js — CLOUDE CART 🛒 | Customer-Facing Bot
// FIXES: 409 conflict, join gate, products, duplicate msgs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const h  = require('./helpers');
const fampay = require('./fampay');
const otpManager = require('./otp-manager');

// FIX 409: webHook:false + no duplicate polling instance
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});
bot.on('polling_error', (err) => {
  const msg = err && (err.message || err.code || String(err));
  console.error('[user polling_error]', msg);
});
bot.on('error', (err) => console.error('[user error]', err && err.message));
module.exports = { bot };

// Answer each callback_query at most once (avoids 400 query too old / invalid)
const _answeredCb = new Set();
async function safeAnswer(q, opts) {
  if (!q || !q.id) return;
  if (_answeredCb.has(q.id)) return;
  _answeredCb.add(q.id);
  try {
    await bot.answerCallbackQuery(q.id, opts || {});
  } catch (e) {
    // ignore expired/invalid query
  }
  if (_answeredCb.size > 2000) {
    const arr = [..._answeredCb];
    arr.slice(0, 1000).forEach((id) => _answeredCb.delete(id));
  }
}


const ADMIN_CHAT   = process.env.ADMIN_NOTIFY_CHAT_ID;
const STORAGE_CHAT = process.env.STORAGE_CHAT_ID || process.env.ADMIN_NOTIFY_CHAT_ID;
const SUPPORT_GROUP = process.env.SUPPORT_GROUP_ID || ''; // public support group announcements

/** Public support-group feed (not private logs channel) */
async function notifySupportGroup(text) {
  if (!SUPPORT_GROUP) return;
  try {
    await bot.sendMessage(SUPPORT_GROUP, text, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    console.error('[support group]', e.message);
  }
}


const REF_REWARD   = Number(process.env.REFERRAL_REWARD_INR) || 10;

// ── Duplicate callback guard ───────────────────────────
const _seen = new Map();
function isDupe(id) {
  if (_seen.has(id)) return true;
  _seen.set(id, 1); setTimeout(() => _seen.delete(id), 6000); return false;
}

// ── Send / Edit helpers ────────────────────────────────
const send = (c, t, o={}) => bot.sendMessage(c, t, { parse_mode:'HTML', ...o });
async function edit(c, m, t, o={}) {
  try { await bot.editMessageText(t, { chat_id:c, message_id:m, parse_mode:'HTML', ...o }); }
  catch(_){}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JOIN GATE
// FIX: always check on /start, support URL delete too
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function checkJoined(userId) {
  const links = db.getDb().settings.joinLinks.filter(l => l.enabled);
  if (!links.length) return true;
  for (const l of links) {
    const m = l.url.match(/t\.me\/(?:\+)?([^/?]+)/);
    if (!m) continue;
    try {
      const mem = await bot.getChatMember('@' + m[1], userId);
      if (['left','kicked'].includes(mem.status)) return false;
    } catch(_) {}
  }
  return true;
}

async function showJoinGate(chatId, msgId=null) {
  const links = db.getDb().settings.joinLinks.filter(l => l.enabled);

  const text =
    `👑 <b>NEXVAULT SHOP</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔒 <b>ACCESS GATE</b>\n\n` +
    `Join our official channels to unlock the store:\n\n` +
    links.map(l => `📣 ${l.name}`).join('\n') +
    `\n\nThen tap <b>✅ I JOINED</b> below.`;

  const kb = [
    ...links.map(l => [{
      text: `📣 ${l.name}`,
      url: l.url,
      style: 'primary'
    }]),
    [{
      text: '✅ I Joined',
      callback_data: 'check_join',
      style: 'success'
    }]
  ];

  const opts = {
    reply_markup: {
      inline_keyboard: kb
    }
  };

  if (msgId) return edit(chatId, msgId, text, opts);
  return send(chatId, text, opts);
}


// MAIN MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showMenu(chatId, msgId=null, isNew=false) {
  const f = db.getDb().settings.features || {};
  const u = db.getUser(String(chatId));
  const bal = u ? (u.balance || 0) : 0;
  const name = (u && (u.firstName || u.username)) ? (u.firstName || u.username) : 'User';
  const text =
    `👑 <b>NEXVAULT SHOP · v3.0 EXCHANGE</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👋 <b>WELCOME, ${escapeHtml(name)}!</b>\n\n` +
    `💎 <b>AUTOMATED DIGITAL ASSET STORE</b>\n` +
    `⚡ INSTANT 24/7 DELIVERY WITH CONTINUOUS\n` +
    `SESSION &amp; ACCOUNT WARRANTY.\n\n` +
    `┌ <b>ACCOUNT SNAPSHOT</b>\n` +
    `│ 💰 WALLET BALANCE: <b>₹${Number(bal).toFixed(2)}</b>\n` +
    `│ ⚡ DELIVERY SPEED: INSTANT\n` +
    `│ 🛡️ STOCK STATUS: VERIFIED &amp; ACTIVE\n` +
    `└\n\n` +
    `✨ TAP AN OPTION BELOW TO BROWSE\nSTOCK OR TOP UP:`;

  const kb = [];
  if (f.buyAccount !== false) {
    kb.push([{ text: '🛒 BROWSE STOCK', callback_data: 'buy_account', style: 'primary' }]);
  }
  if (f.buySession) {
    kb.push([{ text: '📂 BUY SESSIONS', callback_data: 'buy_session', style: 'primary' }]);
  }
  const row2 = [];
  if (f.deposit !== false) row2.push({ text: '💵 ADD FUNDS', callback_data: 'deposit', style: 'success' });
  row2.push({ text: '👤 MY PROFILE', callback_data: 'profile', style: 'primary' });
  if (row2.length) kb.push(row2);
  kb.push([
    { text: '📦 ORDERS HISTORY', callback_data: 'orders_history', style: 'primary' },
    { text: '💬 24/7 SUPPORT', callback_data: 'support', style: 'primary' },
  ]);
  if (f.referEarn !== false) {
    kb.push([{ text: '🎁 REFER &amp; EARN', callback_data: 'refer_earn', style: 'success' }]);
  }
  const opts = { reply_markup: { inline_keyboard: kb } };
  if (msgId) return edit(chatId, msgId, text, opts);
  return send(chatId, text, opts);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const userId  = String(msg.from.id);
  const payload = (match[1]||'').trim();

  if (db.isBanned(userId)) return send(chatId, '🚫 You have been banned.');

  const user = db.getUser(userId);
  db.updateUser(userId, {
    username:  msg.from.username  || user.username,
    firstName: msg.from.first_name || user.firstName,
  });

  // Referral
  if (payload.startsWith('ref_') && !db.hasBeenReferred(userId)) {
    const rid = payload.replace('ref_','');
    if (rid !== userId) db.createReferral(rid, userId, REF_REWARD);
  }

  // FIX: always show join gate if not joined
  const joined = await checkJoined(userId);
  if (!joined) return showJoinGate(chatId);

  // Complete referral
  const ref = db.completeReferral(userId);
  if (ref) {
    try {
      const referrer = db.getUser(ref.referrerId);
      send(ref.referrerId, `🎁 <b>Referral Reward!</b>\nSomeone you referred joined!\n+₹${ref.rewardAmount} added.\n💰 Balance: ${h.formatBalance(referrer.balance)}`);
    } catch(_){}
  }

  const isNew = !user.depositCount && !user.totalDeposited;
  showMenu(chatId, null, isNew);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUY ACCOUNT — FIX: shows all products regardless of stock
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showBuyAccount(chatId, msgId) {
  const db_  = db.getDb();
  const rate = db_.settings.usdtToInrRate || 90;
  let prods = db.listProducts(false);
  // fallback: show every product if none tagged as Account
  if (!prods.length) {
    prods = Object.values(db_.products || {}).filter(Boolean);
  }

  if (!prods.length) return edit(chatId, msgId,
    `📦 <b>No accounts listed yet.</b>\n\nAdmin must Add Product first.`,
    { reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'main_menu',style:'primary'}]]} }
  );

  // Flash sale
  const fs = db_.settings.flashSale;
  let flashLine = '';
  if (fs && fs.active && fs.endsAt) {
    const tl = h.flashSaleTimeLeft(fs.endsAt);
    if (tl) flashLine = `\n🔥 <b>Flash Sale!</b> Ends in <code>${tl}</code>`;
    else { db_.settings.flashSale.active=false; db.saveDb(); }
  }

  const lines = prods.map(p => {
    const usd   = (p.price/rate).toFixed(2);
    const stock = p.stock>0 ? `${p.stock} In Stock` : '❌ Out of Stock';
    return `${p.emoji||'📦'} ${p.name} | $${usd} • ₹${p.price} | ${stock}`;
  });

  const text =
    `🛒 <b>BROWSE STOCK</b>\n━━━━━━━━━━━━━━━━━━━━\n⚡ Rate: 1 USDT = ₹${rate}${flashLine}\n\n` +
    `🟢 Good Quality 2FA\n✅ Age Of The Accounts Are Valued Using (Personal Message)\n\n` +
    lines.join('\n');

  const kb = [
    ...prods.map(p=>[{
      text: `${p.emoji||'📦'} ₹${p.price}`,
      callback_data: p.stock>0 ? `product_${p.id}` : `oos_${p.id}`,
      style: p.stock>0 ? 'success' : 'danger',
    }]),
    [{text:'🔙 Back', callback_data:'main_menu', style:'primary'}],
  ];
  return edit(chatId, msgId, text, { reply_markup:{inline_keyboard:kb} });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BUY SESSION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showBuySession(chatId, msgId) {
  const rate  = db.getDb().settings.usdtToInrRate || 90;
  const prods = db.listProducts(true);

  if (!prods.length) return edit(chatId, msgId,
    `📂 <b>No sessions listed yet.</b>`,
    { reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'main_menu',style:'primary'}]]} }
  );

  const lines = prods.map(p => {
    const usd   = (p.price/rate).toFixed(2);
    const stock = p.stock>0 ? `${p.stock} In Stock` : '❌ Out of Stock';
    return `${p.emoji||'📂'} ${p.name} | $${usd} • ₹${p.price} | ${stock}`;
  });

  const text = `📂 <b>Buy Sessions</b>\n⚡ Rate: 1 USDT = ₹${rate}\n\nBuy in bulk — up to available stock\n\n` + lines.join('\n');
  const kb = [
    ...prods.map(p=>[{ text:`${p.emoji||'📂'} ${p.name} — ₹${p.price}`, callback_data: p.stock>0?`product_${p.id}`:`oos_${p.id}`, style: p.stock>0?'success':'danger' }]),
    [{text:'🔙 Back', callback_data:'main_menu', style:'primary'}],
  ];
  return edit(chatId, msgId, text, { reply_markup:{inline_keyboard:kb} });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRODUCT DETAIL + PURCHASE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showProduct(chatId, msgId, pid) {
  const p    = db.getProduct(pid);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  const back = p && p.sessionMode ? 'buy_session' : 'buy_account';
  if (!p) return edit(chatId, msgId, `❌ Product not found.`, { reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:back,style:'primary'}]]} });
  const usd  = (p.price/rate).toFixed(2);
  const text =
    `${p.emoji||'📦'} <b>${p.name}</b>\n\n💵 $${usd} • ₹${p.price}\n📦 Stock: ${p.stock}` +
    (p.description ? `\n📝 ${p.description}` : '') + `\n\n⚠️ Confirm purchase?`;
  return edit(chatId, msgId, text, { reply_markup:{inline_keyboard:[
    [{text:'✅ Buy Now',callback_data:`buy_${pid}`,style:'success'},{text:'❌ Cancel',callback_data:back,style:'danger'}],
    [{text:'🔙 Back',callback_data:back,style:'primary'}],
  ]}});
}

async function doPurchase(chatId, msgId, userId, pid) {
  const p = db.getProduct(pid);
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  const back = p && p.sessionMode ? 'buy_session' : 'buy_account';

  if (!p || !Array.isArray(p.inventory) || p.inventory.length < 1) {
    return edit(chatId, msgId, `❌ Out of stock.`, {
      reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:back,style:'primary'}]]}
    });
  }

  if (user.balance < p.price) {
    const short = (p.price - user.balance).toFixed(2);
    return edit(chatId, msgId,
      `💰 <b>Insufficient Balance</b>\n\nNeed ₹${short} more.\nCurrent: ${h.formatBalance(user.balance)}`,
      {reply_markup:{inline_keyboard:[
        [{text:'💳 Deposit Now',callback_data:'deposit',style:'success'}],
        [{text:'🔙 Back',callback_data:back,style:'primary'}]
      ]}}
    );
  }

  // Atomically consume exactly ONE credential from this product.
  // The password is never sent to the admin chat and is never broadcast.
  const deliveryItem = db.consumeInventoryItem(pid);
  if (!deliveryItem) {
    return edit(chatId, msgId, `❌ This product just went out of stock. Please try again.`, {
      reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:back,style:'primary'}]]}
    });
  }

  const newBal = user.balance - p.price;
  db.updateUser(userId, { balance: newBal, totalSpent: (user.totalSpent || 0) + p.price });
  const order = db.createOrder({
    userId: String(userId),
    productId: pid,
    quantity: 1,
    totalPrice: p.price,
    inventoryItemId: deliveryItem.id || null,
    login: deliveryItem.login || '',
    twoFaPassword: deliveryItem.password || '',
    status: 'delivered'
  });
  const usd = (p.price / rate).toFixed(2);

  try {
    // Deliver ONLY the Email/Number immediately. Password stays with admin.
    const phoneLogin = String(deliveryItem.login || '').replace(/\D/g, '');
    const canAutoOtp = otpManager.ready() && otpManager.hasSession(phoneLogin);
    let otpNote = `🔐 <b>OTP:</b> Enter number in Telegram and request code.\n`;
    if (canAutoOtp) {
      otpNote = `⚡ <b>Auto OTP ON</b> — bot will send login code here when it arrives.\n`;
    } else {
      otpNote += `If OTP does not arrive, tap <b>🔄 Get OTP Again</b>.\n`;
    }
    await bot.sendMessage(userId,
      `🎉 <b>Purchase Successful!</b>\n\n` +
      `📦 <b>${p.emoji || '📦'} ${p.name}</b>\n` +
      `💸 Paid: ₹${p.price} ($${usd})\n` +
      `🧾 Order ID: <code>#${order.id}</code>\n\n` +
      `📧 <b>Number:</b> <code>${escapeHtml(deliveryItem.login)}</code>\n\n` +
      otpNote,
      {parse_mode:'HTML', reply_markup:{inline_keyboard:[[
        {text:'🔄 Get OTP Again',callback_data:`fetch_password_${order.id}`,style:'success'}
      ]]}}
    );
    if (canAutoOtp) {
      const twoFa = String(deliveryItem.password || '').trim();
      const REFUND_MS = 5 * 60 * 1000; // 5 minutes
      db.updateOrder(order.id, { otpDelivered: false, refunded: false });

      const doRefundIfNeeded = async (reason) => {
        try {
          const ord = db.getOrder(order.id);
          if (!ord || ord.otpDelivered || ord.refunded) return;
          db.updateOrder(order.id, { refunded: true, status: 'refunded', refundReason: reason || 'otp_timeout' });
          const u = db.getUser(userId);
          db.updateUser(userId, { balance: (u.balance || 0) + p.price });
          try { db.restoreInventoryItem(pid, deliveryItem); } catch(_){}
          await bot.sendMessage(userId,
            `⏰ <b>OTP not received in 5 minutes</b>\n\n` +
            `💰 ₹${p.price} has been <b>refunded</b> to your wallet.\n` +
            `Order #${order.id} cancelled.\n\nYou can buy again when ready.`,
            { parse_mode: 'HTML' }
          );
          try {
            if (ADMIN_CHAT) await bot.sendMessage(ADMIN_CHAT,
              `↩️ Auto-refund order #${order.id} user ${userId} ₹${p.price} (${reason||'otp timeout'})`,
              { parse_mode: 'HTML' });
          } catch(_){}
        } catch (e) {
          console.error('auto refund', e.message);
        }
      };

      const refundTimer = setTimeout(() => { doRefundIfNeeded('5min_no_otp'); }, REFUND_MS);

      otpManager.listenOtp(phoneLogin, async (code) => {
        clearTimeout(refundTimer);
        const ord = db.getOrder(order.id);
        if (ord && ord.refunded) {
          await bot.sendMessage(userId, '⚠️ Order already refunded. OTP ignored.');
          return;
        }
        db.updateOrder(order.id, { otpDelivered: true, lastPasswordSentAt: Date.now(), status: 'delivered', lastOtp: code });
        let text =
          `✅ <b>Purchase Successful!</b>\n\n` +
          `📱 <b>Number:</b> <code>+${phoneLogin}</code>\n` +
          `🔢 <b>OTP:</b> <code>${code}</code>\n`;
        if (twoFa) {
          text += `🔐 <b>2FA Password:</b> <code>${escapeHtml(twoFa)}</code>\n`;
        }
        text += `\n⚠️ Keep these details private.\n\nUse buttons below after you login:`;
        await bot.sendMessage(userId, text, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗑 Terminate Bot Session', callback_data: `term_sess_${order.id}`, style: 'danger' }],
              [{ text: '📱 Manage Sessions', callback_data: `mgmt_sess_${order.id}`, style: 'primary' }],
              [{ text: '🔄 Get OTP Again', callback_data: `fetch_password_${order.id}`, style: 'success' }],
            ],
          },
        });
      }, async (st) => {
        if (st === 'listening') {
          await bot.sendMessage(userId, '⏳ Listening for OTP (5 min)… open Telegram and request the code now.');
        } else if (st === 'timeout') {
          await doRefundIfNeeded('listener_timeout');
        } else if (st && st !== 'listening') {
          await bot.sendMessage(userId, `⚠️ ${st}`);
        }
      }, REFUND_MS).catch(e => console.error('listenOtp', e.message));
    }

    db.updateOrder(order.id, {status:'password_pending', passwordRequestCount:0});

    await edit(chatId, msgId,
      `✅ <b>Order Purchased!</b>\n\n` +
      `📦 ${p.emoji || '📦'} ${p.name}\n` +
      `💸 ₹${p.price} ($${usd}) deducted\n` +
      `💰 Remaining: ${h.formatBalance(newBal)}\n\n` +
      `📧 <b>Number:</b> <code>${escapeHtml(deliveryItem.login)}</code>\n\n` +
      `🔐 <b>Password:</b> Copy Number And Send Code.
        Waiting for OTP , Admin will Send Code after OTP comes.\n\n` +
      `Tap <b>🔑 Fetch OTP</b> to send a OTP request to the admin.`,
      {reply_markup:{inline_keyboard:[
        [{text:'🔄 Get OTP Again',callback_data:`fetch_password_${order.id}`,style:'success'}],
        [{text:'🔙 Main Menu',callback_data:'main_menu',style:'primary'}]
      ]}}
    );

    // Admin is informed that an order exists, but receives no password.
    const adminText =
      `🛒 <b>NEW ORDER</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 User: ${user.username ? '@' + user.username : user.firstName || 'Unknown'}\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `📦 Product: ${p.emoji || ''} ${p.name}\n` +
      `💰 Price: ₹${p.price} ($${usd})\n` +
      `📧 Email / Number: <code>${escapeHtml(deliveryItem.login)}</code>\n` +
      `📦 Remaining Stock: ${db.getProduct(pid).stock}\n` +
      `📋 Order ID: #${order.id}\n` +
      `📅 ${new Date().toLocaleString('en-IN')}\n\n` +
      `🔐 OTP will be sent only when the buyer requests it.`;

    try {
      await h._adminBot.sendMessage(ADMIN_CHAT, adminText, {
        parse_mode:'HTML',
        reply_markup:{inline_keyboard:[[
          {text:'✉️ Message User',callback_data:`msg_${userId}`,style:'primary'}
        ]]}
      });
    } catch (e) {
      console.error('[ORDER NOTIFY]', e.message);
    }
    // Public support group — no number/OTP/password
    try {
      const uname = user.username ? '@' + user.username : (user.firstName || 'User');
      await notifySupportGroup(
        `🛒 <b>Purchase Successful</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `👤 User: ${uname}\n` +
        `🆔 ID: <code>${userId}</code>\n` +
        `📦 Product: ${p.emoji || ''} ${p.name}\n` +
        `💵 Paid: <b>₹${p.price}</b>\n` +
        `📋 Order #${order.id}\n` +
        `🕐 ${new Date().toLocaleString('en-IN')}`
      );
    } catch (_) {}
  } catch (e) {
    // If Telegram delivery fails, restore both the user's money and the stock item.
    db.restoreInventoryItem(pid, deliveryItem);
    db.updateUser(userId, { balance:user.balance, totalSpent:user.totalSpent || 0 });
    db.updateOrder(order.id, {status:'delivery_failed', error:e.message});
    console.error('[DELIVERY ERROR]', e.message);

    try {
      await h._adminBot.sendMessage(ADMIN_CHAT,
        `⚠️ <b>AUTO DELIVERY FAILED</b>\n\n` +
        `User: <code>${userId}</code>\n` +
        `Product: ${p.name}\n` +
        `Order: #${order.id}\n` +
        `Reason: ${escapeHtml(e.message)}`,
        {parse_mode:'HTML'}
      );
    } catch (_) {}

    return edit(chatId, msgId,
      `⚠️ <b>Delivery failed</b>\n\nYour balance was not charged and the stock item was restored. Please contact support.`,
      {reply_markup:{inline_keyboard:[[{text:'📞 Support',callback_data:'support',style:'primary'}]]}}
    );
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROFILE + LEADERBOARD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function showOrdersHistory(chatId, msgId, userId) {
  const list = (db.getUserOrders ? db.getUserOrders(userId, 12) : []);
  let body = `📦 <b>ORDERS HISTORY</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (!list.length) {
    body += `No orders yet.\nBrowse stock to make your first purchase.`;
  } else {
    body += list.map(o => {
      const p = db.getProduct(o.productId);
      const nm = p ? `${p.emoji||'📦'} ${p.name}` : 'Product';
      const st = (o.status || '').replace(/_/g, ' ');
      const when = o.createdAt ? new Date(o.createdAt).toLocaleString('en-IN') : '-';
      return `• <b>#${o.id}</b> ${nm}\n  ₹${o.totalPrice||0} · ${st}\n  ${when}`;
    }).join('\n\n');
  }
  return edit(chatId, msgId, body, {
    reply_markup: { inline_keyboard: [[{ text: '🔙 MAIN MENU', callback_data: 'main_menu', style: 'primary' }]] }
  });
}

async function showProfile(chatId, msgId, userId) {
  const user = db.getUser(userId);
  const rate = db.getDb().settings.usdtToInrRate || 90;
  return edit(chatId, msgId,
    `👤 <b>MY PROFILE</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `💰 WALLET: <b>${h.formatBalance(user.balance)}</b>\n` +
    `📥 TOTAL DEPOSITED: ₹${Number(user.totalDeposited||0).toFixed(2)}\n` +
    `🔁 DEPOSITS: ${user.depositCount||0}\n` +
    `🎁 REFERRALS: ${user.referralCount||0} (₹${Number(user.referralEarned||0).toFixed(2)})\n` +
    `📅 JOINED: ${new Date(user.joinedAt).toLocaleDateString('en-IN')}`,
    { reply_markup:{inline_keyboard:[
      [{text:'🏆 TOP DEPOSITORS',callback_data:'lb_dep',style:'primary'},{text:'🎁 TOP REFERRERS',callback_data:'lb_ref',style:'primary'}],
      [{text:'🔙 MAIN MENU',callback_data:'main_menu',style:'primary'}],
    ]}}
  );
}

async function showLeaderboard(chatId, msgId, type) {
  const list  = type==='dep' ? db.getDepositLeaderboard(10) : db.getReferralLeaderboard(10);
  const title = type==='dep' ? '💰 Top Depositors' : '🎁 Top Referrers';
  const lines = list.map((u,i) => {
    const name = u.username?`@${u.username}`:(u.firstName||`User ${u.userId}`);
    const val  = type==='dep'?`₹${u.totalDeposited.toFixed(2)}`:`${u.referralCount} refs`;
    return `${h.medal(i)} ${name} — ${val}`;
  });
  return edit(chatId, msgId,
    `🏆 <b>${title}</b>\n\n${lines.join('\n')||'No data yet.'}`,
    { reply_markup:{inline_keyboard:[
      [{text:'💰 Deposit Board',callback_data:'lb_dep',style:'primary'},{text:'🎁 Refer Board',callback_data:'lb_ref',style:'primary'}],
      [{text:'🔙 Back',callback_data:'profile',style:'primary'}],
    ]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REFER & EARN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showRefer(chatId, msgId, userId) {
  const info = await bot.getMe();
  const link = `https://t.me/${info.username}?start=ref_${userId}`;
  const user = db.getUser(userId);
  return edit(chatId, msgId,
    `🎁 <b>REFER &amp; EARN</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Share your link and earn <b>₹${REF_REWARD}</b> per successful referral.\n\n` +
    `🔗 <b>YOUR LINK</b>\n<code>${link}</code>\n\n` +
    `👥 REFERRALS: <b>${user.referralCount||0}</b>\n` +
    `💵 EARNED: <b>₹${Number(user.referralEarned||0).toFixed(2)}</b>`,
    { reply_markup:{inline_keyboard:[[{text:'🔙 MAIN MENU',callback_data:'main_menu',style:'primary'}]]} }
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SUPPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showSupport(chatId, msgId) {
  const sup = db.getDb().settings.supportUsername;
  return edit(chatId, msgId,
    `💬 <b>24/7 SUPPORT</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Our team is online for refunds, delivery help &amp; account issues.\n\n` +
    `Tap below to open a chat:`,
    { reply_markup:{inline_keyboard:[
      [{text:'💬 CONTACT SUPPORT',url:`https://t.me/${sup}`,style:'primary'}],
      [{text:'🔙 MAIN MENU',callback_data:'main_menu',style:'primary'}],
    ]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEPOSIT FLOW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function showDeposit(chatId, msgId) {
  const db_  = db.getDb(); const pay = db_.settings.payments;
  if (!db_.settings.features.deposit) return edit(chatId,msgId,`🚫 Deposits currently disabled.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'main_menu',style:'primary'}]]}});
  const kb=[];
  if (fampay.enabled()) kb.push([{text:'⚡ FamPay Auto (QR)',callback_data:'dep_fampay',style:'success'}]);
  if (pay.gpay.enabled||pay.fampay.enabled||pay.anyupi.enabled) kb.push([{text:'📱 UPI Payment (Manual)',callback_data:'dep_upi',style:'primary'}]);
  if (pay.binance.enabled) kb.push([{text:'💳 Binance Pay (USDT)',callback_data:'dep_binance',style:'primary'}]);
  kb.push([{text:'🔙 Back',callback_data:'main_menu',style:'primary'}]);
  return edit(chatId,msgId,
    `💵 <b>ADD FUNDS</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ Minimum: <b>₹${db_.settings.minDepositInr||20}</b>\n` +
    `⚡ FamPay Auto credits after screenshot + verify\n` +
    `📸 Manual UPI needs admin approval\n\n` +
    `✨ Choose a payment method:`,
    {reply_markup:{inline_keyboard:kb}});
}

async function showUpiOptions(chatId, msgId) {
  const pay = db.getDb().settings.payments;
  const min = db.getDb().settings.minDepositInr||20;
  const kb=[];
  if (pay.gpay.enabled)   kb.push([{text:'📱 G Pay',   callback_data:'upi_gpay',style:'primary'}]);
  if (pay.fampay.enabled) kb.push([{text:'💳 Fam Pay', callback_data:'upi_fampay',style:'primary'}]);
  if (pay.anyupi.enabled) kb.push([{text:'🗃️ Any UPI',callback_data:'upi_anyupi',style:'primary'}]);
  kb.push([{text:'🔙 Back',callback_data:'deposit',style:'primary'}]);
  return edit(chatId,msgId,`📱 <b>UPI Payment</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: ₹${min}\n⚠️ Manual verification after screenshot\n\nChoose your UPI app:`,{reply_markup:{inline_keyboard:kb}});
}

async function showUpiMethod(chatId, msgId, userId, method) {
  const db_ = db.getDb(); const pay = db_.settings.payments[method]; const min=db_.settings.minDepositInr||20;
  const names={gpay:'G Pay',fampay:'Fam Pay',anyupi:'Any UPI'};
  if (!pay || !pay.enabled) return edit(chatId,msgId,`🚫 Disabled.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'dep_upi',style:'primary'}]]}});
  h.setUserState(userId, 'awaiting_amount', {method});
  const cap =
    `📱 <b>${names[method]}</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Minimum: ₹${min}\n` +
    (pay.upiId?`🆔 UPI ID: <code>${pay.upiId}</code>\n`:'')+
    (pay.upiName?`👤 Name: ${pay.upiName}\n`:'')+
    `\nEnter amount in ₹ (minimum ₹${min}):`;
  if (pay.qrFileId) {
    try { await bot.deleteMessage(chatId,msgId); } catch(_){}
    return bot.sendPhoto(chatId, pay.qrFileId, {caption:cap, parse_mode:'HTML', reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'dep_upi',style:'primary'}]]}});
  }
  return edit(chatId,msgId,cap,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'dep_upi',style:'primary'}]]}});
}

async function showBinance(chatId, msgId, userId) {
  const db_=db.getDb(); const pay=db_.settings.payments.binance; const min=db_.settings.minDepositInr||20; const rate=db_.settings.usdtToInrRate||90;
  if (!pay.enabled) return edit(chatId,msgId,`🚫 Binance Pay disabled.`,{reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'deposit',style:'primary'}]]}});
  h.setUserState(userId,'awaiting_amount',{method:'binance'});
  return edit(chatId,msgId,
    `💳 <b>Binance Pay (USDT)</b>\n━━━━━━━━━━━━━━━━━━━━\n`+
    (pay.binanceId?`🆔 ID: <code>${pay.binanceId}</code>\n`:'')+
    (pay.binanceName?`👤 Name: ${pay.binanceName}\n`:'')+
    `\nEnter amount in ₹ (min ₹${min} = $${(min/rate).toFixed(2)} USDT):`,
    {reply_markup:{inline_keyboard:[[{text:'🔙 Back',callback_data:'deposit',style:'primary'}]]}}
  );
}


async function creditFampayDeposit(userId, depositId, amount, chatId) {
  const dep = db.getDeposit(depositId);
  if (!dep || dep.status !== 'pending') return false;
  db.updateDeposit(depositId, { status: 'approved', approvedAt: Date.now() });
  const user = db.getUser(userId);
  const newBal = (user.balance || 0) + amount;
  db.updateUser(userId, {
    balance: newBal,
    totalDeposited: (user.totalDeposited || 0) + amount,
    depositCount: (user.depositCount || 0) + 1,
  });
  try { db.completeReferral(userId); } catch (_) {}
  await send(chatId || userId,
    `✅ <b>Payment verified & credited!</b>\n\n💰 ₹${amount} added to wallet.\nBalance: ${h.formatBalance(newBal)}`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'main_menu', style: 'primary' }]] } }
  );
  // Logs channel (STORAGE_CHAT_ID)
  try {
    const logChat = STORAGE_CHAT || ADMIN_CHAT;
    if (logChat) {
      const u = db.getUser(userId);
      const dep = db.getDeposit(depositId);
      const cap =
        `📥 <b>DEPOSIT LOG — AUTO CREDIT</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 User: ${u.username ? '@' + u.username : (u.firstName || 'User')}\n` +
        `🆔 ID: <code>${userId}</code>\n` +
        `💰 Amount: <b>₹${amount}</b>\n` +
        `💳 Method: FamPay Auto\n` +
        `📋 Deposit: #${depositId}\n` +
        `📝 Purpose: <code>${(dep && dep.fampayPurpose) || '-'}</code>\n` +
        `💼 New Balance: ${h.formatBalance(newBal)}\n` +
        `📅 ${new Date().toLocaleString('en-IN')}`;
      const photo = dep && (dep.screenshotFileIdAdmin || dep.screenshotFileId);
      if (photo) {
        await bot.sendPhoto(logChat, photo, { caption: cap, parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(logChat, cap, { parse_mode: 'HTML' });
      }
    }
  } catch (e) {
    console.error('storage log', e.message);
  }
  // Public support group (users can see)
  try {
    const u = db.getUser(userId);
    const uname = u.username ? '@' + u.username : (u.firstName || 'User');
    await notifySupportGroup(
      `💰 <b>New Deposit</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `👤 User: ${uname}\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `💵 Amount: <b>₹${amount}</b>\n` +
      `💳 Method: FamPay Auto\n` +
      `📋 #${depositId}\n` +
      `🕐 ${new Date().toLocaleString('en-IN')}`
    );
  } catch (_) {}
  return true;
}

async function handleFampayAmount(msg, state) {
  const chatId = msg.chat.id; const userId = String(msg.from.id);
  const amount = parseFloat(msg.text); const min = db.getDb().settings.minDepositInr || 20;
  if (isNaN(amount) || amount < min) return send(chatId, `⚠️ Minimum ₹${min}. Try again:`);
  try {
    const order = await fampay.createOrder(Number(userId), amount);
    const deposit = db.createDeposit({
      userId,
      amount,
      method: 'fampay_auto',
      fampayOrderId: order.id,
      fampayPurpose: order.purpose,
      screenshotFileId: null,
      screenshotReceived: false,
      paymentVerified: false,
      screenshotFileIdAdmin: null,
    });
    // Wait for screenshot BEFORE any credit
    h.setUserState(userId, 'awaiting_fampay_screenshot', {
      amount,
      depositId: deposit.id,
      fampayOrderId: order.id,
    });
    await bot.sendPhoto(chatId, order.qrPng, {
      caption:
        `⚡ <b>FamPay Auto</b>\n\n` +
        `💰 Amount: <b>₹${amount}</b>\n` +
        `🆔 Order: <code>${order.id}</code>\n` +
        `📝 Purpose: <code>${order.purpose}</code>\n\n` +
        `1️⃣ Scan QR and pay\n` +
        `2️⃣ Then <b>send payment screenshot here</b>\n\n` +
        `⏳ Balance will credit <b>only after screenshot</b> + payment verify.\n` +
        `Do not close this chat.`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Check Payment Status', callback_data: `fampay_check_${order.id}`, style: 'success' }],
          [{ text: '❌ Cancel', callback_data: 'deposit', style: 'danger' }],
        ],
      },
    });
    // Background: mark paymentVerified when email found — still NO credit until screenshot
    fampay.pollUntilPaid(order.id, async () => {
      const dep = db.getDeposit(deposit.id);
      if (!dep || dep.status !== 'pending') return;
      db.updateDeposit(deposit.id, { paymentVerified: true });
      // If screenshot already uploaded, credit now
      if (dep.screenshotReceived) {
        await creditFampayDeposit(userId, deposit.id, amount, chatId);
      } else {
        try {
          await send(chatId,
            `✅ Payment detected in email.\n📸 Please send your <b>payment screenshot</b> now to credit balance.`,
            { parse_mode: 'HTML' });
        } catch (_) {}
      }
    }, async () => {
      const dep = db.getDeposit(deposit.id);
      if (dep && dep.status === 'pending') db.updateDeposit(deposit.id, { status: 'expired' });
      try { await send(chatId, `⏰ Payment order expired. Start deposit again.`); } catch (_) {}
      h.clearUserState(userId);
    }, 12000);
  } catch (e) {
    h.clearUserState(userId);
    return send(chatId, `❌ FamPay error: ${e.message}`);
  }
}

async function handleAmount(msg, state) {
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  const amount=parseFloat(msg.text); const min=db.getDb().settings.minDepositInr||20;
  if (isNaN(amount)||amount<min) return send(chatId,`⚠️ Minimum ₹${min}. Try again:`);
  h.setUserState(userId,'awaiting_screenshot',{method:state.data.method,amount});
  const rate=db.getDb().settings.usdtToInrRate||90;
  return send(chatId,
    `💰 Amount: ₹${amount} ($${(amount/rate).toFixed(2)} USDT)\n\n📸 Please send your payment screenshot now:`,
    {reply_markup:{inline_keyboard:[[{text:'❌ Cancel',callback_data:'deposit',style:'danger'}]]}}
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHOTO — Cross-Bot Photo Relay (payment screenshot)
// FIX: admin pe direct message + auto-pin + screenshot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('photo', async (msg) => {
  const chatId=msg.chat.id; const userId=String(msg.from.id);
  const state=h.getUserState(userId);
  if (!state) return;

  // ── FamPay: screenshot required before credit ──
  if (state.state === 'awaiting_fampay_screenshot') {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const { amount, depositId, fampayOrderId } = state.data || {};
    const dep = db.getDeposit(depositId);
    if (!dep || dep.status !== 'pending') {
      h.clearUserState(userId);
      return send(chatId, '⚠️ This deposit is no longer pending. Start again from Deposit.');
    }
    db.updateDeposit(depositId, { screenshotFileId: fileId, screenshotReceived: true });
    h.clearUserState(userId);

    const adminFileId = await h.relayPhotoToAdmin(fileId, ADMIN_CHAT).catch(() => null);
    if (adminFileId) db.updateDeposit(depositId, { screenshotFileIdAdmin: adminFileId });

    await send(chatId,
      `📸 <b>Screenshot received!</b>\n\n💰 ₹${amount}\n📋 Deposit #${depositId}\n\n⏳ Verifying payment…`,
      { parse_mode: 'HTML' }
    );

    // Notify admin (info only — auto credit, no approve needed)
    try {
      if (ADMIN_CHAT) {
        const u = db.getUser(userId);
        await (h._adminBot || bot).sendPhoto(ADMIN_CHAT, adminFileId || fileId, {
          caption:
            `⚡ <b>FamPay deposit — screenshot in</b>\n` +
            `User: <code>${userId}</code> @${u.username || ''}\n` +
            `₹${amount} | #${depositId}\nOrder: <code>${fampayOrderId}</code>\n` +
            `Auto-credit after verify (no manual approve).`,
          parse_mode: 'HTML',
        });
      }
    } catch (e) { console.error('fampay admin notify', e.message); }

    // Verify now (or use already verified flag)
    let verified = !!(dep.paymentVerified);
    if (!verified && fampayOrderId) {
      try {
        const r = await fampay.verify(fampayOrderId);
        verified = !!r.verified;
        if (verified) db.updateDeposit(depositId, { paymentVerified: true });
      } catch (e) {
        console.error('fampay verify after ss', e.message);
      }
    }

    if (verified) {
      await creditFampayDeposit(userId, depositId, amount, chatId);
    } else {
      // Keep pending; poll will credit when email arrives (screenshot already marked)
      await send(chatId,
        `⏳ Screenshot saved. Payment email not matched yet.\n` +
        `As soon as FamPay mail is found, balance will credit automatically.\n` +
        `You can tap Check Payment Status on the QR message.`,
        { parse_mode: 'HTML' }
      );
      // Keep polling path already running from handleFampayAmount
    }
    return;
  }

  if (state.state!=='awaiting_screenshot') return;
  h.clearUserState(userId);

  const fileId=msg.photo[msg.photo.length-1].file_id;
  const {method,amount}=state.data;
  const rate=db.getDb().settings.usdtToInrRate||90;
  const usd=(amount/rate).toFixed(2);
  const user=db.getUser(userId);

  const deposit=db.createDeposit({userId,amount,method,screenshotFileId:fileId,screenshotFileIdAdmin:null});

  await send(chatId,
    `✅ <b>Screenshot Received!</b>\n\n💰 ₹${amount} ($${usd})\n📋 Deposit ID: #${deposit.id}\n\n⏳ Please wait a few minutes for admin approval.`,
    {reply_markup:{inline_keyboard:[[{text:'🔙 Main Menu',callback_data:'main_menu',style:'primary'}]]}}
  );

  // Cross-Bot Photo Relay: User Bot → Admin Bot
  const adminFileId = await h.relayPhotoToAdmin(fileId, ADMIN_CHAT);
  if (adminFileId) db.updateDeposit(deposit.id,{screenshotFileIdAdmin:adminFileId});

  const cap =
    `💰 <b>NEW DEPOSIT REQUEST</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 User: ${user.username?'@'+user.username:user.firstName||'Unknown'}\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `💵 Amount: ₹${amount} ($${usd} USDT)\n` +
    `💳 Method: ${method.toUpperCase()}\n` +
    `💼 Current Balance: ₹${user.balance.toFixed(2)}\n` +
    `📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n` +
    `🔁 Deposit Count: ${user.depositCount+1}\n` +
    `📋 Deposit ID: #${deposit.id}\n` +
    `📅 ${new Date().toLocaleString('en-IN')}`;

  const akb={inline_keyboard:[
    [{text:'✅ Approve',callback_data:`dep_ok_${deposit.id}`,style:'success'},{text:'❌ Reject',callback_data:`dep_no_${deposit.id}`,style:'danger'}],
    [{text:'✉️ Message User',callback_data:`msg_${userId}`,style:'primary'}],
  ]};

  try {
    const sendId=adminFileId||fileId;
    const aMsg=await h._adminBot.sendPhoto(ADMIN_CHAT,sendId,{caption:cap,parse_mode:'HTML',reply_markup:akb});
    try{await h._adminBot.pinChatMessage(ADMIN_CHAT,aMsg.message_id);}catch(_){}
  } catch(_) {
    try {
      const aMsg=await h._adminBot.sendMessage(ADMIN_CHAT,cap+'\n\n⚠️ Screenshot relay failed — ask user to resend.',{parse_mode:'HTML',reply_markup:akb});
      try{await h._adminBot.pinChatMessage(ADMIN_CHAT,aMsg.message_id);}catch(_){}
    } catch(e){console.error('[DEP NOTIFY]',e.message);}
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEXT HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('message', async (msg) => {
  if (!msg.text||msg.text.startsWith('/')) return;
  const userId=String(msg.from.id);
  const state=h.getUserState(userId);
  if (!state) return;
  if (state.state==='fampay_amount') return handleFampayAmount(msg,state);
  if (state&&state.state==='awaiting_amount') return handleAmount(msg,state);
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

  if (db.isBanned(userId)) return send(chatId,'🚫 You are banned.');

  if (data!=='check_join') {
    const joined=await checkJoined(userId);
    if (!joined) return showJoinGate(chatId,msgId);
  }

  if (data==='check_join') {
    const joined=await checkJoined(userId);
    if (!joined) {
      const links=db.getDb().settings.joinLinks.filter(l=>l.enabled);
      return edit(chatId,msgId,`❌ <b>Not joined yet!</b>\n\nPlease join all links then press ✅`,
        {reply_markup:{inline_keyboard:[...links.map(l=>[{text:l.name,url:l.url,style:'primary'}]),
          [{text:'✅ I Joined',callback_data:'check_join',style:'success'}]]}});
    }
    db.completeReferral(userId);
    const user=db.getUser(userId); const isNew=!user.depositCount&&!user.totalDeposited;
    return edit(chatId,msgId,`✅ <b>All Verified!</b>\n\nWelcome! Tap below or send /start.`,
      {reply_markup:{inline_keyboard:[[{text:'🚀 Start Now',callback_data:isNew?'menu_new':'main_menu',style:'success'}]]}});
  }

  if (data==='main_menu')    return showMenu(chatId,msgId,false);
  if (data==='menu_new')     return showMenu(chatId,msgId,true);
  if (data==='buy_account')  return showBuyAccount(chatId,msgId);
  if (data==='buy_session')  return showBuySession(chatId,msgId);
  if (data==='profile')      return showProfile(chatId,msgId,userId);
  if (data==='orders_history') return showOrdersHistory(chatId,msgId,userId);
  if (data==='deposit')      return showDeposit(chatId,msgId);
  if (data==='dep_fampay') {
    if (!fampay.enabled()) return safeAnswer(q,{text:'FamPay not configured',show_alert:true});
    const min=db.getDb().settings.minDepositInr||20;
    h.setUserState(userId,'fampay_amount',{});
    return edit(chatId,msgId,`⚡ <b>FamPay Auto</b>\n\nEnter amount in ₹ (min ₹${min}):`,{
      reply_markup:{inline_keyboard:[[{text:'❌ Cancel',callback_data:'deposit',style:'danger'}]]}
    });
  }
  if (data.startsWith('fampay_check_')) {
    const oid=data.replace('fampay_check_','');
    await safeAnswer(q, { text: 'Checking…' });
    try {
      const r=await fampay.verify(oid);
      // find deposit by fampayOrderId
      const all = Object.values(db.getDb().deposits || {});
      const dep = all.find(d => d.fampayOrderId === oid && d.status === 'pending');
      if (r.verified && dep) {
        db.updateDeposit(dep.id, { paymentVerified: true });
        if (dep.screenshotReceived) {
          await creditFampayDeposit(userId, dep.id, dep.amount, chatId);
          return safeAnswer(q,{text:'✅ Verified & credited!',show_alert:true});
        }
        return safeAnswer(q,{text:'✅ Payment OK — send screenshot to credit',show_alert:true});
      }
      return safeAnswer(q,{text:r.verified?'✅ Payment OK — send screenshot':`${r.status}: ${r.message}`.slice(0,180),show_alert:true});
    } catch(e) {
      return safeAnswer(q,{text:String(e.message).slice(0,180),show_alert:true});
    }
  }
  if (data==='dep_upi')      return showUpiOptions(chatId,msgId);
  if (data==='upi_gpay')     return showUpiMethod(chatId,msgId,userId,'gpay');
  if (data==='upi_fampay')   return showUpiMethod(chatId,msgId,userId,'fampay');
  if (data==='upi_anyupi')   return showUpiMethod(chatId,msgId,userId,'anyupi');
  if (data==='dep_binance')  return showBinance(chatId,msgId,userId);
  if (data==='refer_earn')   return showRefer(chatId,msgId,userId);
  if (data==='support')      return showSupport(chatId,msgId);
  if (data==='lb_dep')       return showLeaderboard(chatId,msgId,'dep');
  if (data==='lb_ref')       return showLeaderboard(chatId,msgId,'ref');
  if (data.startsWith('fetch_password_')) {
    const oid = data.replace('fetch_password_','');
    const ord = db.getOrder(oid);
    if (!ord || String(ord.userId) !== userId) {
      return safeAnswer(q,{text:'❌ Order not found.',show_alert:true});
    }
    await safeAnswer(q, { text: 'OK' });
    const phoneLogin = String(ord.login || '').replace(/\D/g, '');
    if (!otpManager.ready() || !otpManager.hasSession(phoneLogin)) {
      return safeAnswer(q,{
        text:'Auto OTP session not available. Contact support.',
        show_alert:true
      });
    }
    // Load 2FA from product inventory if still stored on order product stock used item — use order fields
    let twoFa = '';
    try {
      const p = db.getProduct(ord.productId);
      // password may not be on order; check inventory used items by login match is hard — store on order at buy time
      twoFa = String(ord.twoFaPassword || ord.password || '').trim();
    } catch(_){}
    await safeAnswer(q,{text:'Listening for OTP…'});
    await send(chatId, '⏳ Listening for OTP again… open Telegram and request the code.');
    if (ord.refunded) {
      return safeAnswer(q,{text:'Order was refunded.',show_alert:true});
    }
    otpManager.listenOtp(phoneLogin, async (code) => {
      db.updateOrder(oid, { otpDelivered: true, lastPasswordSentAt: Date.now(), status: 'delivered', lastOtp: code });
      let text =
        `✅ <b>Purchase Successful!</b>\n\n` +
        `📱 <b>Number:</b> <code>+${phoneLogin}</code>\n` +
        `🔢 <b>OTP:</b> <code>${code}</code>\n`;
      if (twoFa) {
        text += `🔐 <b>2FA Password:</b> <code>${escapeHtml(twoFa)}</code>\n`;
      }
      text += `\n⚠️ Keep these details private.`;
      await bot.sendMessage(userId, text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Terminate Bot Session', callback_data: `term_sess_${oid}`, style: 'danger' }],
            [{ text: '📱 Manage Sessions', callback_data: `mgmt_sess_${oid}`, style: 'primary' }],
            [{ text: '🔄 Get OTP Again', callback_data: `fetch_password_${oid}`, style: 'success' }],
          ],
        },
      });
    }, async (st) => {
      if (st === 'timeout') await send(chatId, '⏰ OTP timeout. Try Get OTP Again later.');
      else if (st && st !== 'listening') await send(chatId, `⚠️ ${st}`);
    }, 5 * 60 * 1000).catch(e => console.error('listenOtp retry', e.message));
    return;
  }
  if (data.startsWith('term_sess_')) {
    const oid = data.replace('term_sess_', '');
    const ord = db.getOrder(oid);
    if (!ord || String(ord.userId) !== userId) {
      return safeAnswer(q, { text: 'Order not found', show_alert: true });
    }
    await safeAnswer(q, { text: 'Terminating…' });
    if (ord.refunded) {
      return safeAnswer(q, { text: 'Order refunded', show_alert: true });
    }
    const phone = String(ord.login || '').replace(/\D/g, '');
    try {
      await otpManager.terminateBotSession(phone);
      db.updateOrder(oid, { botSessionTerminated: true });
      await safeAnswer(q, { text: 'Bot session removed', show_alert: true });
      return edit(chatId, msgId,
        `✅ <b>Bot session terminated</b>\n\n📱 +${phone}\n\nBot is no longer logged into this account. Your phone login is safe.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'main_menu', style: 'primary' }]] } }
      );
    } catch (e) {
      return safeAnswer(q, { text: String(e.message).slice(0, 150), show_alert: true });
    }
  }
  if (data.startsWith('mgmt_sess_')) {
    const oid = data.replace('mgmt_sess_', '');
    const ord = db.getOrder(oid);
    if (!ord || String(ord.userId) !== userId) {
      return safeAnswer(q, { text: 'Order not found', show_alert: true });
    }
    const phone = String(ord.login || '').replace(/\D/g, '');
    if (!otpManager.hasSession(phone)) {
      return safeAnswer(q, { text: 'Bot session already removed. Cannot manage.', show_alert: true });
    }
    await safeAnswer(q, { text: 'Loading sessions…' });
    try {
      const list = await otpManager.listAuthorizations(phone);
      let text = `📱 <b>Active Sessions</b>\n<code>+${phone}</code>\n\n`;
      const kb = [];
      list.forEach((a, i) => {
        const tag = a.current ? ' <i>(BOT — this shop)</i>' : '';
        const when = a.dateActive ? new Date(a.dateActive * 1000).toLocaleString('en-IN') : '-';
        text += `${i + 1}. <b>${escapeHtml(a.device)}</b>${tag}\n   ${escapeHtml(a.app || a.platform)} | ${escapeHtml(a.country || '')}\n   IP: ${escapeHtml(a.ip || '-')} | ${when}\n\n`;
        if (!a.current) {
          kb.push([{ text: `🗑 Remove #${i + 1} ${String(a.device).slice(0, 20)}`, callback_data: `rm_auth_${oid}_${a.hash}`, style: 'danger' }]);
        }
      });
      kb.push([{ text: '🗑 Terminate Bot Session', callback_data: `term_sess_${oid}`, style: 'danger' }]);
      kb.push([{ text: '🔄 Refresh', callback_data: `mgmt_sess_${oid}`, style: 'primary' }]);
      kb.push([{ text: '🔙 Main Menu', callback_data: 'main_menu', style: 'primary' }]);
      await safeAnswer(q);
      return edit(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      return safeAnswer(q, { text: String(e.message).slice(0, 150), show_alert: true });
    }
  }
  if (data.startsWith('rm_auth_')) {
    const rest = data.replace('rm_auth_', '');
    const firstUnd = rest.indexOf('_');
    if (firstUnd < 0) return safeAnswer(q, { text: 'Bad data', show_alert: true });
    const oid = rest.slice(0, firstUnd);
    const hash = rest.slice(firstUnd + 1);
    const ord = db.getOrder(oid);
    if (!ord || String(ord.userId) !== userId) {
      return safeAnswer(q, { text: 'Order not found', show_alert: true });
    }
    const phone = String(ord.login || '').replace(/\D/g, '');
    try {
      await otpManager.resetAuthorization(phone, hash);
      await safeAnswer(q, { text: 'Session removed ✓', show_alert: true });
      const list = await otpManager.listAuthorizations(phone);
      let text = `📱 <b>Active Sessions</b> (updated)\n<code>+${phone}</code>\n\n`;
      const kb = [];
      list.forEach((a, i) => {
        const tag = a.current ? ' <i>(BOT)</i>' : '';
        text += `${i + 1}. <b>${escapeHtml(a.device)}</b>${tag}\n   ${escapeHtml(a.app || a.platform)} | ${escapeHtml(a.country || '')}\n\n`;
        if (!a.current) {
          kb.push([{ text: `🗑 Remove #${i + 1} ${String(a.device).slice(0, 20)}`, callback_data: `rm_auth_${oid}_${a.hash}`, style: 'danger' }]);
        }
      });
      kb.push([{ text: '🗑 Terminate Bot Session', callback_data: `term_sess_${oid}`, style: 'danger' }]);
      kb.push([{ text: '🔄 Refresh', callback_data: `mgmt_sess_${oid}`, style: 'primary' }]);
      kb.push([{ text: '🔙 Main Menu', callback_data: 'main_menu', style: 'primary' }]);
      return edit(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      return safeAnswer(q, { text: String(e.message).slice(0, 150), show_alert: true });
    }
  }
  if (data.startsWith('oos_'))      return safeAnswer(q,{text:'❌ Out of stock!',show_alert:true});
  if (data.startsWith('product_'))  return showProduct(chatId,msgId,data.replace('product_',''));
  if (data.startsWith('buy_'))      return doPurchase(chatId,msgId,userId,data.replace('buy_',''));
  // unknown callback — just ack
  await safeAnswer(q);
  } catch (err) {
    console.error('[callback]', err && err.message ? err.message : err);
    try { await safeAnswer(q, { text: 'Error, try again', show_alert: true }); } catch(_){}
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUBLIC — called by admin-bot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function notifyDepositApproved(userId, deposit) {
  const user=db.getUser(userId); const rate=db.getDb().settings.usdtToInrRate||90;
  send(userId,
    `✅ <b>Deposit Approved!</b>\n\n💵 ₹${deposit.amount} ($${(deposit.amount/rate).toFixed(2)})\n💰 New Balance: ${h.formatBalance(user.balance)}\n📥 Total Deposited: ₹${user.totalDeposited.toFixed(2)}\n🔁 Deposits: ${user.depositCount}\n\nThank you! 🙏`
  );
}
async function notifyDepositRejected(userId, deposit) {
  const rate=db.getDb().settings.usdtToInrRate||90;
  send(userId,
    `❌ <b>Deposit Rejected</b>\n\n💵 ₹${deposit.amount} ($${(deposit.amount/rate).toFixed(2)})\n\nContact support if this is an error.`,
    {reply_markup:{inline_keyboard:[[{text:'📞 Support',callback_data:'support',style:'primary'}]]}}
  );
}
async function notifyOrderDelivered(userId, order) {
  const p=db.getProduct(order.productId);
  send(userId,`📦 <b>Order Delivered!</b>\n\n${p?(p.emoji||'📦')+' '+p.name:'Your order'} has been delivered.\n\nThank you! 🙏`);
}

module.exports.notifyDepositApproved=notifyDepositApproved;
module.exports.notifyDepositRejected=notifyDepositRejected;
module.exports.notifyOrderDelivered=notifyOrderDelivered;

console.log('🛒 NEXVAULT SHOP User Bot started...');
