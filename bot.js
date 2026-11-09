const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Загрузка .env если есть
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DGIS_WEB_KEY = process.env.DGIS_WEB_KEY || 'c7f1a769-c8a5-4636-b14d-d8c987808a12';
const PORT = process.env.PORT || 3001;

if (!BOT_TOKEN) {
  console.error('❌ ОШИБКА: Не указан BOT_TOKEN в файле .env или переменных окружения!');
  process.exit(1);
}

// Файлы хранения данных
const USERS_FILE = path.join(__dirname, 'users.json');
const SEEN_FILE = path.join(__dirname, 'seen_events.json');
const VOTES_FILE = path.join(__dirname, 'votes.json');

function loadJson(file, def) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return def;
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

let users = loadJson(USERS_FILE, {});
let seenEvents = loadJson(SEEN_FILE, {});
let votes = loadJson(VOTES_FILE, {});
const addressCache = {};

// Базовые ключевые слова для режима «Сигналы»
const DEFAULT_KEYWORDS = [
  'военкомат', 'военком', 'воен', 'военк', 'облава', 'повестк',
  'дпс', 'гаи', 'патруль', 'жолпол', 'рейд', 'проверка'
];

// HTTP клиент с надежными таймаутами и fallback
function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://2gis.kz/almaty',
        'Origin': 'https://2gis.kz',
        'Connection': 'keep-alive',
        ...(options.headers || {})
      },
      timeout: 25000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url} (status ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ETIMEDOUT')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Telegram API вызов
function tgApi(method, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(payload);
    req.end();
  });
}

// Надежное получение живых дорожных событий 2ГИС по Алматы с retry
async function fetchAlmaty2GisEvents() {
  const layers = encodeURIComponent('["camera","crash","roadwork","restriction","comment","other"]');
  const urls = [
    `https://tugc.2gis.com/1.0/layers/user?project=almaty&layers=${layers}`,
    `https://tugc.2gis.ru/1.0/layers/user?project=almaty&layers=${layers}`
  ];

  let lastErr = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await requestJson(url);
        if (Array.isArray(data)) return data;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw lastErr || new Error('Не удалось связаться с сервером 2ГИС');
}

// Определение улицы по координатам через каталог 2ГИС + запасной Nominatim
async function resolveStreetAddress(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (addressCache[key]) return addressCache[key];

  // 1. Пробуем 2GIS Catalog Geocode API
  try {
    const url2gis = `https://catalog.api.2gis.com/3.0/items/geocode?lat=${lat}&lon=${lon}&fields=items.point,items.address&key=${DGIS_WEB_KEY}&locale=ru_KZ`;
    const res = await requestJson(url2gis);
    const item = res?.result?.items?.[0];
    if (item) {
      const addr = item.address_name || item.full_name || item.name;
      if (addr) {
        const clean = addr.replace(/^Алматы,\s*/i, '');
        addressCache[key] = clean;
        return clean;
      }
    }
  } catch (e) {}

  // 2. Запасной вариант: OpenStreetMap Nominatim
  try {
    const urlNom = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&accept-language=ru`;
    const res = await requestJson(urlNom);
    if (res?.address) {
      const road = res.address.road || res.address.pedestrian || res.address.suburb || res.address.neighbourhood || '';
      const house = res.address.house_number ? `, ${res.address.house_number}` : '';
      if (road) {
        const full = `${road}${house}`;
        addressCache[key] = full;
        return full;
      }
    }
  } catch (e) {}

  return 'Координаты на карте Алматы';
}

// Форматирование времени (Алматы UTC+5)
function formatAlmatyTime(unixSec) {
  const ms = (unixSec ? unixSec * 1000 : Date.now()) + (5 * 3600 * 1000);
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Проверка совпадения по ключевым словам
function matchKeywords(text, customKeywords) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const list = customKeywords && customKeywords.length ? customKeywords : DEFAULT_KEYWORDS;
  return list.filter(kw => lower.includes(kw.toLowerCase()));
}

// Тип события на русском
function getEventTypeTitle(type) {
  switch (type) {
    case 'comment': return '💬 Разговорчик (Сообщение)';
    case 'crash': return '💥 ДТП';
    case 'roadwork': return '🚧 Дорожные работы';
    case 'restriction': return '⛔ Перекрытие';
    case 'camera': return '📷 Камера / Пост';
    default: return '⚠️ Дорожное событие';
  }
}

// Сборка карточки сообщения (1-в-1 как на скриншоте)
async function buildEventCard(ev, matchedWords = []) {
  const coords = ev.location?.coordinates || [76.9286, 43.2389];
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  const street = await resolveStreetAddress(lat, lon);
  const author = ev.user?.name || 'Пользователь 2ГИС';
  const comment = (ev.comment || '').trim() || getEventTypeTitle(ev.type);
  const timeStr = formatAlmatyTime(ev.timestamp);

  const isMilitary = matchedWords.some(w => w.startsWith('воен') || w.includes('облава') || w.includes('повестк'));
  const isPolice = matchedWords.some(w => ['дпс', 'гаи', 'патруль', 'жолпол', 'рейд'].includes(w));

  let header = '💬 НОВОЕ СООБЩЕНИЕ В 2ГИС!';
  if (isMilitary) header = '🚨 СИГНАЛ: ВОЕНКОМАТ!';
  else if (isPolice) header = '🚓 СИГНАЛ: ДПС / ПАТРУЛЬ!';
  else if (matchedWords.length > 0) header = '🚨 СИГНАЛ НА КАРТЕ!';

  const lines = [
    header,
    `🏙 Город: Алматы`,
    `📡 Источник: 🗺 Карта 2ГИС (${getEventTypeTitle(ev.type)})`
  ];

  if (matchedWords.length > 0) {
    lines.push(`🔑 Ключевые слова: ${matchedWords.join(', ')}`);
  }

  lines.push(
    `📍 ${street}`,
    `🌐 Координаты: ${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    ``,
    `💬 <b>Сообщение:</b>`,
    `${escapeHtml(comment)}`,
    `👤 Автор на карте: ${escapeHtml(author)}`,
    ``,
    `⏰ Время: ${timeStr}`,
    ``,
    `⚠️ Будьте осторожны в этом районе!`
  );

  // Сохраняем координаты для кнопки «📍 Геолокация» и голосования
  const shortId = ev.id.slice(0, 18);
  if (!votes[shortId]) {
    votes[shortId] = {
      confirm: ev.feedbacks?.likes || 0,
      seen: 0,
      fake: Math.abs(ev.feedbacks?.dislikes || 0),
      lat,
      lon,
      street,
      voters: {}
    };
  }

  const keyboard = buildInlineKeyboard(shortId, lat, lon);
  return { text: lines.join('\n'), keyboard, shortId, lat, lon };
}

function buildInlineKeyboard(shortId, lat, lon) {
  const v = votes[shortId] || { confirm: 0, seen: 0, fake: 0, lat, lon };
  const gmapsUrl = `https://www.google.com/maps?q=${v.lat || lat},${v.lon || lon}`;
  const dgisUrl = `https://2gis.kz/almaty/geo/${v.lon || lon},${v.lat || lat}`;

  return {
    inline_keyboard: [
      [
        { text: '🗺 Google Maps', url: gmapsUrl },
        { text: '🔗 2ГИС', url: dgisUrl }
      ],
      [
        { text: `👍 Подтверждаю${v.confirm ? ` (${v.confirm})` : ''}`, callback_data: `vote|confirm|${shortId}` },
        { text: `👁 Видел${v.seen ? ` (${v.seen})` : ''}`, callback_data: `vote|seen|${shortId}` },
        { text: `👎 Ложное${v.fake ? ` (${v.fake})` : ''}`, callback_data: `vote|fake|${shortId}` }
      ],
      [
        { text: '📍 Геолокация', callback_data: `loc|${shortId}` }
      ]
    ]
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Главное меню бота
function getMainReplyKeyboard(user) {
  const modeLabel = user.mode === 'all'
    ? '📡 Режим: ВСЕ сообщения (Вкл)'
    : '🚨 Режим: Только Сигналы (Вкл)';
  const muteLabel = user.muted ? '🔔 Включить авто-радар' : '🔕 Пауза авто-радара';

  return {
    keyboard: [
      [{ text: '🔍 Сканировать Алматы сейчас' }, { text: '🚨 Показать сигналы на карте' }],
      [{ text: modeLabel }, { text: '🔑 Мои ключевые слова' }],
      [{ text: muteLabel }, { text: '📊 Статистика карты 2ГИС' }]
    ],
    resize_keyboard: true
  };
}

function ensureUser(chatId, name) {
  if (!users[chatId]) {
    users[chatId] = {
      chatId,
      name: name || 'Пользователь',
      mode: 'signals', // 'signals' | 'all'
      muted: false,
      keywords: [...DEFAULT_KEYWORDS],
      awaitingKeywords: false,
      createdAt: Date.now()
    };
    saveJson(USERS_FILE, users);
  }
  return users[chatId];
}

// Фоновый сканер карты 2ГИС Алматы
let isScanning = false;
async function scan2GisLoop(isInitial = false) {
  if (isScanning) return;
  isScanning = true;
  try {
    const events = await fetchAlmaty2GisEvents();
    const nowSec = Math.floor(Date.now() / 1000);

    // Оставляем только события с текстом комментария
    const commentEvents = events.filter(e => e.comment && String(e.comment).trim().length > 0);

    for (const ev of commentEvents) {
      if (seenEvents[ev.id]) continue;

      // При самом первом запуске помечаем старые события (> 30 минут назад) как прочитанные,
      // но самые свежие сигналы отправляем!
      seenEvents[ev.id] = nowSec;

      if (isInitial && (nowSec - (ev.timestamp || nowSec)) > 3600) {
        continue;
      }

      // Проверяем для каждого подписчика
      for (const chatId of Object.keys(users)) {
        const u = users[chatId];
        if (u.muted) continue;

        const matched = matchKeywords(ev.comment, u.keywords);
        // Игнорируем чисто технические комментарии камер ("40", "60") в режиме "all", если это просто цифра скорости
        const isJustSpeedNumber = ev.type === 'camera' && /^\d{2,3}$/.test(String(ev.comment).trim());

        if (u.mode === 'signals' && matched.length > 0) {
          const card = await buildEventCard(ev, matched);
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: card.text,
            parse_mode: 'HTML',
            reply_markup: card.keyboard
          });
        } else if (u.mode === 'all' && !isJustSpeedNumber) {
          const card = await buildEventCard(ev, matched);
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: card.text,
            parse_mode: 'HTML',
            reply_markup: card.keyboard
          });
        }
      }
    }

    // Чистим старые ID (старше 24 часов)
    for (const id of Object.keys(seenEvents)) {
      if (nowSec - seenEvents[id] > 86400) delete seenEvents[id];
    }
    saveJson(SEEN_FILE, seenEvents);
    saveJson(VOTES_FILE, votes);
  } catch (err) {
    console.error('Ошибка сканирования 2ГИС:', err.message);
  } finally {
    isScanning = false;
  }
}

// Обработка входящих сообщений Telegram
async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  const text = (msg.text || '').trim();
  const user = ensureUser(chatId, msg.from?.first_name);

  if (text === '/start') {
    user.awaitingKeywords = false;
    saveJson(USERS_FILE, users);

    const welcome = [
      `🚨 <b>РАДАР 2ГИС: АЛМАТЫ</b>`,
      ``,
      `Привет, <b>${escapeHtml(user.name)}</b>! Я в реальном времени отслеживаю <b>живые сообщения и метки</b>, которые водители и жители оставляют прямо на карте <b>2ГИС Алматы</b>.`,
      ``,
      `📡 <b>Текущий режим:</b> ${user.mode === 'all' ? '💬 Все сообщения на карте' : '🚨 Только Сигналы (Военкомат / ДПС / Облава)'}`,
      `🔑 <b>Ключевые слова (${user.keywords.length}):</b> <code>${user.keywords.join(', ')}</code>`,
      ``,
      `👇 <b>Нажми кнопку ниже, чтобы просканировать карту прямо сейчас:</b>`
    ].join('\n');

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: welcome,
      parse_mode: 'HTML',
      reply_markup: getMainReplyKeyboard(user)
    });
    return;
  }

  // Если пользователь вводит новые ключевые слова
  if (user.awaitingKeywords && !text.startsWith('/') && !text.startsWith('🔍') && !text.startsWith('🚨') && !text.startsWith('📡') && !text.startsWith('🔑') && !text.startsWith('🔔') && !text.startsWith('🔕') && !text.startsWith('📊')) {
    if (text.toLowerCase() === 'сброс') {
      user.keywords = [...DEFAULT_KEYWORDS];
    } else {
      const words = text.split(/[,;\n]+/).map(w => w.trim().toLowerCase()).filter(Boolean);
      if (words.length > 0) user.keywords = words;
    }
    user.awaitingKeywords = false;
    saveJson(USERS_FILE, users);

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `✅ <b>Ключевые слова обновлены!</b>\n\nТеперь я ищу на карте 2ГИС Алматы:\n<code>${user.keywords.join(', ')}</code>`,
      parse_mode: 'HTML',
      reply_markup: getMainReplyKeyboard(user)
    });
    return;
  }

  // Кнопка: Показать сигналы на карте
  if (text === '🚨 Показать сигналы на карте') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '🛰 <b>Сканирую карту 2ГИС Алматы на наличие сигналов...</b>',
      parse_mode: 'HTML'
    });

    try {
      const events = await fetchAlmaty2GisEvents();
      const matchedEvents = [];
      for (const ev of events) {
        if (!ev.comment) continue;
        const m = matchKeywords(ev.comment, user.keywords);
        if (m.length > 0) matchedEvents.push({ ev, m });
      }

      if (matchedEvents.length === 0) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `✅ <b>На данный момент на карте 2ГИС Алматы тревожных меток не найдено!</b>\n\nВсего активных событий на карте: <b>${events.length}</b>.\nЯ продолжаю мониторинг каждые 45 секунд — как только кто-то напишет на карте, я сразу пришлю сигнал!`,
          parse_mode: 'HTML',
          reply_markup: getMainReplyKeyboard(user)
        });
      } else {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `🚨 <b>Найдено активных сигналов на карте 2ГИС Алматы: ${matchedEvents.length}</b>`,
          parse_mode: 'HTML'
        });
        for (const item of matchedEvents.slice(0, 10)) {
          const card = await buildEventCard(item.ev, item.m);
          await tgApi('sendMessage', {
            chat_id: chatId,
            text: card.text,
            parse_mode: 'HTML',
            reply_markup: card.keyboard
          });
        }
      }
    } catch (e) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `⚠️ Ошибка связи с сервером 2ГИС: ${e.message}`
      });
    }
    return;
  }

  // Кнопка: Сканировать Алматы сейчас (показывает последние живые разговорчики)
  if (text === '🔍 Сканировать Алматы сейчас') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '🗺 <b>Загружаю последние живые сообщения с карты 2ГИС Алматы...</b>',
      parse_mode: 'HTML'
    });

    try {
      const events = await fetchAlmaty2GisEvents();
      // Берем живые комментарии (кроме технических цифр камер "40", "60")
      const comments = events
        .filter(e => e.comment && !(e.type === 'camera' && /^\d{2,3}$/.test(String(e.comment).trim())))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      if (comments.length === 0) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: 'На карте сейчас нет текстовых сообщений.',
          reply_markup: getMainReplyKeyboard(user)
        });
        return;
      }

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `💬 <b>Сейчас на карте 2ГИС Алматы ${comments.length} текстовых сообщений.</b>\nПоказываю 5 самых свежих:`,
        parse_mode: 'HTML'
      });

      for (const ev of comments.slice(0, 5)) {
        const matched = matchKeywords(ev.comment, user.keywords);
        const card = await buildEventCard(ev, matched);
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.keyboard
        });
      }
    } catch (e) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `⚠️ Ошибка при загрузке карты 2ГИС: ${e.message}`
      });
    }
    return;
  }

  // Переключение режима (Только Сигналы <-> ВСЕ сообщения)
  if (text.startsWith('🚨 Режим:') || text.startsWith('📡 Режим:')) {
    user.mode = user.mode === 'signals' ? 'all' : 'signals';
    saveJson(USERS_FILE, users);

    const desc = user.mode === 'all'
      ? '📡 <b>Включен режим: ВСЕ сообщения на карте 2ГИС Алматы!</b>\nТеперь бот будет присылать вообще каждое новое текстовое сообщение, которое люди оставляют на карте Алматы.'
      : `🚨 <b>Включен режим: Только Сигналы!</b>\nТеперь бот будет присылать уведомления только тогда, когда в сообщении на карте есть ключевые слова (<code>${user.keywords.slice(0, 6).join(', ')}...</code>).`;

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: desc,
      parse_mode: 'HTML',
      reply_markup: getMainReplyKeyboard(user)
    });
    return;
  }

  // Настройка ключевых слов
  if (text === '🔑 Мои ключевые слова') {
    user.awaitingKeywords = true;
    saveJson(USERS_FILE, users);

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: [
        `🔑 <b>Настройка ключевых слов</b>`,
        ``,
        `Сейчас отслеживаются слова:`,
        `<code>${user.keywords.join(', ')}</code>`,
        ``,
        `✍️ <b>Отправь мне в ответ список слов через запятую</b> (например: <code>военкомат, воен, облава, дпс, гаи</code>), или напиши <code>сброс</code> для возврата стандартного списка.`
      ].join('\n'),
      parse_mode: 'HTML',
      reply_markup: getMainReplyKeyboard(user)
    });
    return;
  }

  // Пауза / Включение авто-радара
  if (text === '🔕 Пауза авто-радара' || text === '🔔 Включить авто-радар') {
    user.muted = !user.muted;
    saveJson(USERS_FILE, users);

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: user.muted
        ? '🔕 <b>Автоматические уведомления поставлены на паузу.</b> Вы всё ещё можете сканировать карту вручную кнопками меню.'
        : '🔔 <b>Авто-радар снова включен!</b> Я проверяю карту 2ГИС Алматы каждые 45 секунд.',
      parse_mode: 'HTML',
      reply_markup: getMainReplyKeyboard(user)
    });
    return;
  }

  // Статистика карты 2ГИС
  if (text === '📊 Статистика карты 2ГИС') {
    try {
      const events = await fetchAlmaty2GisEvents();
      const byType = { comment: 0, crash: 0, roadwork: 0, camera: 0, restriction: 0, other: 0 };
      let signalsCount = 0;

      for (const e of events) {
        byType[e.type] = (byType[e.type] || 0) + 1;
        if (e.comment && matchKeywords(e.comment, user.keywords).length > 0) {
          signalsCount++;
        }
      }

      const statText = [
        `📊 <b>ЖИВАЯ СТАТИСТИКА КАРТЫ 2ГИС (АЛМАТЫ)</b>`,
        ``,
        `🟢 Всего активных точек на карте: <b>${events.length}</b>`,
        `💬 Разговорчики (сообщения): <b>${byType.comment || 0}</b>`,
        `💥 ДТП (Аварии): <b>${byType.crash || 0}</b>`,
        `🚧 Дорожные работы: <b>${byType.roadwork || 0}</b>`,
        `📷 Камеры / Посты: <b>${byType.camera || 0}</b>`,
        `⛔ Перекрытия: <b>${byType.restriction || 0}</b>`,
        ``,
        `🚨 <b>Сообщений по вашим ключевым словам сейчас: ${signalsCount}</b>`
      ].join('\n');

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: statText,
        parse_mode: 'HTML',
        reply_markup: getMainReplyKeyboard(user)
      });
    } catch (e) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `⚠️ Ошибка получения статистики: ${e.message}`
      });
    }
    return;
  }

  // Любой другой текст — ищем совпадения прямо сейчас по карте Алматы!
  const query = text.toLowerCase();
  try {
    const events = await fetchAlmaty2GisEvents();
    const found = events.filter(e => e.comment && String(e.comment).toLowerCase().includes(query));

    if (found.length > 0) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `🔎 Найдено совпадений на карте 2ГИС Алматы по запросу «<b>${escapeHtml(text)}</b>»: <b>${found.length}</b>`,
        parse_mode: 'HTML'
      });
      for (const ev of found.slice(0, 5)) {
        const card = await buildEventCard(ev, [text]);
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.keyboard
        });
      }
    } else {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `🔎 По слову «<b>${escapeHtml(text)}</b>» прямо сейчас меток на карте 2ГИС Алматы нет.\n\nИспользуйте кнопки внизу для сканирования всей карты!`,
        parse_mode: 'HTML',
        reply_markup: getMainReplyKeyboard(user)
      });
    }
  } catch (e) {}
}

// Обработка нажатий на инлайн-кнопки (Голосование и Геолокация)
async function handleCallback(cb) {
  const data = cb.data || '';
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const userId = String(cb.from?.id || '');

  if (data.startsWith('loc|')) {
    const shortId = data.split('|')[1];
    const v = votes[shortId];
    if (v && v.lat && v.lon) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '📍 Отправляю точку на карте...'
      });
      await tgApi('sendLocation', {
        chat_id: chatId,
        latitude: v.lat,
        longitude: v.lon
      });
    } else {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'Координаты указаны в тексте сообщения выше 👆',
        show_alert: false
      });
    }
    return;
  }

  if (data.startsWith('vote|')) {
    const [, type, shortId] = data.split('|');
    if (!votes[shortId]) {
      votes[shortId] = { confirm: 0, seen: 0, fake: 0, voters: {} };
    }
    const v = votes[shortId];
    if (!v.voters) v.voters = {};

    const prevVote = v.voters[userId];
    if (prevVote === type) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'Вы уже выбрали этот вариант!'
      });
      return;
    }

    if (prevVote && v[prevVote] > 0) v[prevVote]--;
    v[type] = (v[type] || 0) + 1;
    v.voters[userId] = type;
    saveJson(VOTES_FILE, votes);

    const labels = {
      confirm: '👍 Вы подтвердили сигнал!',
      seen: '👁 Отмечено: Вы видели это на месте!',
      fake: '👎 Отмечено как ложная метка!'
    };

    await tgApi('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: labels[type] || 'Голос учтён!'
    });

    if (v.lat && v.lon && chatId && messageId) {
      await tgApi('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildInlineKeyboard(shortId, v.lat, v.lon)
      });
    }
  }
}

// Long Polling Telegram
let offset = 0;
async function pollTelegram() {
  while (true) {
    try {
      const res = await tgApi('getUpdates', { offset, timeout: 25 });
      if (res && res.ok && Array.isArray(res.result)) {
        for (const upd of res.result) {
          offset = upd.update_id + 1;
          if (upd.message) await handleMessage(upd.message);
          else if (upd.callback_query) await handleCallback(upd.callback_query);
        }
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Веб-сервер для круглосуточной работы в облаке (Render.com / cron-job.org)
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    status: 'ok',
    service: '2GIS Almaty Radar Bot',
    subscribers: Object.keys(users).length,
    trackedEvents: Object.keys(seenEvents).length
  }));
}).listen(PORT, () => {
  console.log(`🌐 Сервер здоровья запущен на порту ${PORT}`);
});

(async () => {
  const me = await tgApi('getMe', {});
  if (me && me.ok) {
    console.log(`✅ Радар 2ГИС Алматы успешно запущен: @${me.result.username}`);
  } else {
    console.log('⚠️ Не удалось проверить токен бота. Проверьте BOT_TOKEN.');
  }

  // Первичное сканирование и запуск таймера каждые 45 секунд
  await scan2GisLoop(true);
  setInterval(() => scan2GisLoop(false), 45 * 1000);

  pollTelegram();
})();
