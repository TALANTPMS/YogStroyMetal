const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const router = express.Router();

router.use(cors());
router.use(bodyParser.json());

// ======================
// 🧩 ДОБАВЛЕНО: настройки Bitrix24
// ======================

const BITRIX_METHOD = 'crm.lead.add.json';

// Шаблон Bitrix24 для будущего подключения (заполни своими значениями)
const BITRIX_TEMPLATE = {
  ENABLED: false,
  WEBHOOK: '', // Пример: 'https://yourcompany.bitrix24.ru/rest/1/your_webhook_key/'
  FILE_FIELD_ID: 'UF_CRM_FILE_FIELD_ID',
  MESSENGER_FIELD_ID: 'UF_CRM_MESSENGER_FIELD_ID'
};

// Настройки UniSender Go API
const UNISENDER_GO_API_KEY = process.env.UNISENDER_GO_API_KEY.trim();
const UNISENDER_GO_FROM_EMAIL = 'noreply@lp-chat.kz';
const UNISENDER_GO_FROM_NAME = 'YugStroyMetal';

// Почта парсера amoCRM (создаёт сделку из письма)
const AMOCRM_PARSER_EMAIL = '32638030.235443@parser.amocrm.ru';

// Шаблон Telegram для будущего подключения (по умолчанию выключен)
const TELEGRAM_TEMPLATE = {
  ENABLED: true,
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  CHAT_ID: process.env.TELEGRAM_CHAT_ID || ''
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildTelegramMessage(data) {
  const name = escapeHtml(data.name || 'Не указано');
  const phone = escapeHtml(data.phone || 'Не указано');
  const messenger = escapeHtml(data.messenger || 'Не указан');
  const sectionName = escapeHtml(data.section_name || 'Заявка с сайта');
  const sectionText = escapeHtml(data.section_name_text || '');
  const buttonText = escapeHtml(data.section_btn_text || '');
  const pageUrl = escapeHtml(data.page_url || 'Не указан');
  const lines = [
    '<b>Новая заявка с сайта chat.krasnodar-naves.ru</b>',
    '',
    `<b>Источник:</b> ${sectionName}`,
    sectionText ? `<b>Текст блока:</b> ${sectionText}` : '',
    buttonText ? `<b>Кнопка:</b> ${buttonText}` : '',
    `<b>Имя:</b> ${name}`,
    `<b>Телефон:</b> ${phone}`,
    `<b>Мессенджер:</b> ${messenger}`,
    `<b>Страница:</b> ${pageUrl}`
  ];

  return lines.filter(Boolean).join('\n');
}

async function sendLeadToTelegram(data) {
  if (!TELEGRAM_TEMPLATE.ENABLED) {
    return { success: false, skipped: true, reason: 'Telegram template disabled' };
  }

  if (!TELEGRAM_TEMPLATE.BOT_TOKEN || !TELEGRAM_TEMPLATE.CHAT_ID) {
    return { success: false, error: 'TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы' };
  }

  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TEMPLATE.BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_TEMPLATE.CHAT_ID,
        text: buildTelegramMessage(data),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    if (!response.data?.ok) {
      return { success: false, error: response.data?.description || 'Telegram API error' };
    }

    const chatHistory = String(data.chat_history || '').trim();
    if (chatHistory) {
      const limitedChatHistory = chatHistory.length > 1000000
        ? `${chatHistory.substring(0, 1000000)}\n\n... (обрезано)`
        : chatHistory;

      const historyFile = new FormData();
      historyFile.append('chat_id', TELEGRAM_TEMPLATE.CHAT_ID);
      historyFile.append(
        'document',
        Buffer.from(limitedChatHistory, 'utf8'),
        {
          filename: `chat_history_${Date.now()}.txt`,
          contentType: 'text/plain'
        }
      );
      historyFile.append('caption', 'История переписки');

      const docResponse = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TEMPLATE.BOT_TOKEN}/sendDocument`,
        historyFile,
        {
          headers: historyFile.getHeaders(),
          timeout: 15000
        }
      );

      if (!docResponse.data?.ok) {
        return { success: false, error: docResponse.data?.description || 'Telegram document API error' };
      }
    }

    return { success: true, messageId: response.data.result?.message_id };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.description || error.message || 'Telegram send failed'
    };
  }
}

const UNISENDER_GO_ENDPOINTS = [
  'https://go1.unisender.ru/ru/transactional/api/v1/email/send.json',
  'https://go2.unisender.ru/ru/transactional/api/v1/email/send.json'
];

/**
 * Собирает текст заявки для парсера amoCRM.
 * Форма обратной связи: мессенджер и история — прочерк.
 */
function buildAmoCrmParserBody(data) {
  const name = String(data.name || '').trim() || '—';
  const phone = String(data.phone || '').trim() || '—';
  const messenger = String(data.messenger || '').trim() || '—';

  const chatHistoryRaw = String(data.chat_history || '').trim();
  let historySection = '—';

  if (chatHistoryRaw) {
    const lines = chatHistoryRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        let text = line;
        if (text.startsWith('Менеджер:')) {
          text = `Бот:${text.slice('Менеджер:'.length)}`;
        }
        return `** ${text}**`;
      });

    if (lines.length) {
      historySection = [
        '----------------------------------',
        ...lines,
        '----------------------------------'
      ].join('\n');
    }
  }

  return [
    `Имя: ${name}`,
    `Телефон: ${phone}`,
    `Мессенджер: ${messenger}`,
    '',
    'ИСТОРИЯ ПЕРЕПИСКИ:',
    historySection
  ].join('\n');
}

async function sendUniSenderGoMessage(message) {
  let lastError = null;

  for (const url of UNISENDER_GO_ENDPOINTS) {
    try {
      const response = await axios.post(url, { message }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-KEY': UNISENDER_GO_API_KEY
        },
        timeout: 10000
      });

      const apiData = response.data || {};
      const jobId = apiData.job_id
        || apiData.result?.job_id
        || apiData.result?.message_id
        || apiData.message_id;

      return {
        success: true,
        messageId: jobId || 'unknown',
        server: url.includes('go1') ? 'go1' : 'go2',
        responseData: apiData
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Оба сервера UniSender Go недоступны. Последняя ошибка: ${lastError?.response?.data?.error || lastError?.message}`
  );
}

/**
 * Отправляет заявку на парсер amoCRM (plain text для разбора полей).
 */
async function sendLeadToAmoCrmParser(data) {
  try {
    const plaintext = buildAmoCrmParserBody(data);
    const historyChars = String(data.chat_history || '').trim().length;
    const historyInBody = plaintext.includes('----------------------------------');

    console.log('📧 amoCRM parser: подготовка письма', {
      historyChars,
      historyInBody,
      bodyChars: plaintext.length
    });

    const result = await sendUniSenderGoMessage({
      recipients: [{ email: AMOCRM_PARSER_EMAIL }],
      subject: 'Заявка с сайта',
      from_email: UNISENDER_GO_FROM_EMAIL,
      from_name: UNISENDER_GO_FROM_NAME,
      body: { plaintext },
      track_read: 0,
      track_links: 0
    });

    console.log('✅ amoCRM parser: письмо отправлено', result.messageId, {
      historyInBody,
      bodyChars: plaintext.length
    });
    return {
      success: true,
      message: 'Заявка отправлена в amoCRM parser',
      emailMethod: 'UniSender Go API',
      messageId: result.messageId,
      server: result.server,
      historyInBody,
      historyChars: String(data.chat_history || '').trim().length
    };
  } catch (error) {
    console.error('❌ amoCRM parser:', error.message);
    return {
      success: false,
      error: error.response?.data?.error || error.message
    };
  }
}

/**
 * Отправляет письмо через UniSender Go API
 */
async function sendEmailViaUniSenderGo(data) {
  try {
    // Формируем HTML письмо
    const html = generateEmailHTML(data);
    
    // Подготавливаем данные для UniSender Go API
    const emailData = {
      message: {
        recipients: [
          { email: 'idrisovamir21tr@gmail.com' },
          { email: 'mpleads@yandex.kz' }
        ],
        subject: 'Заявка с сайта "chat.krasnodar-naves.ru"',
        from_email: UNISENDER_GO_FROM_EMAIL,
        from_name: UNISENDER_GO_FROM_NAME,
        body: {
          html: html,
          plaintext: html.replace(/<[^>]*>/g, '') // Убираем HTML теги для plaintext
        },
        track_read: 1,
        track_links: 1,
        options: {
          custom_backend_id: 22229  // ID домена ссылок для использования (указывается в объекте options внутри message)
        }
      }
    };

    // Добавляем вложение, если есть история чата
    if (data.chat_history && data.chat_history.trim()) {
      // Ограничиваем размер истории чата (максимум 1MB)
      const chatHistory = data.chat_history.length > 1000000 
        ? data.chat_history.substring(0, 1000000) + '\n\n... (обрезано)'
        : data.chat_history;
        
      emailData.message.attachments = [{
        type: 'text/plain',
        name: 'chat_history.txt',
        content: Buffer.from(chatHistory, 'utf8').toString('base64')
      }];
      
      console.log('📎 Добавлено вложение:', {
        name: emailData.message.attachments[0].name,
        size: chatHistory.length,
        type: emailData.message.attachments[0].type
      });
    }

    const result = await sendUniSenderGoMessage(emailData.message);
    console.log('✅ Успех:', result.responseData);
    return {
      success: true,
      message: 'Заявка успешно отправлена!',
      emailMethod: 'UniSender Go API',
      messageId: result.messageId,
      server: result.server
    };
  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data?.error || error.message 
    };
  }
}

/**
 * Генерирует HTML письмо
 */
function generateEmailHTML(data) {
  const fields = {
    name: ['Имя отправителя', 'Name', data.name || ''],
    phone: ['Номер телефона', 'Phone', data.phone || ''],
    messenger: ['Мессенджер', 'Messenger', data.messenger || ''],
    utm_source: ['Источник трафика', 'utm_source', data.utm_source || ''],
    utm_medium: ['Тип рекламы', 'utm_medium', data.utm_medium || ''],
    utm_campaign: ['Номер рекламной кампании', 'utm_campaign', data.utm_campaign || ''],
    utm_content: ['Контент кампании', 'utm_content', data.utm_content || ''],
    utm_term: ['Ключевое слово', 'utm_term', data.utm_term || ''],
    utm_device: ['Тип устройства', 'utm_device', data.utm_device || ''],
    utm_campaign_name: ['Название рекламного кабинета', 'utm_campaign_name', data.utm_campaign_name || ''],
    utm_placement: ['Место показа', 'utm_placement', data.utm_placement || ''],
    utm_description: ['Текст рекламного объявления', 'utm_description', data.utm_description || ''],
    utm_region_name: ['Регион', 'utm_region_name', data.utm_region_name || ''],
    device_type: ['Тип устройства (доп.)', 'device_type', data.device_type || ''],
    yclid: ['Яндекс Клик ID', 'yclid', data.yclid || ''],
    page_url: ['URL страницы', 'page_url', data.page_url || ''],
    user_location_ip: ['IP/Гео пользователя', 'user_location_ip', data.user_location_ip || ''],
    'section_btn_text': ['Текст на кнопке', 'Answertext', data['section_btn_text'] || ''],
    'section_name_text': ['Заголовок на экране, с которого оставлена заявка', 'Section-name-text', data['section_name_text'] || ''],
    'section_name': ['Тип формы', 'Section-name', data['section_name'] || ''],
  };

  const groups = {
    'Информация, указанная посетителем сайта:': {
      fields: ['name', 'phone', 'messenger'],
      html: ''
    },
    'Информация из рекламной системы:': {
      fields: ['page_url', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_device', 'utm_campaign_name', 'utm_placement', 'utm_description', 'utm_region_name', 'device_type', 'yclid', 'user_location_ip'],
      html: ''
    },
    'Кастомная информация:': {
      fields: ['section_btn_text', 'section_name_text', 'section_name'],
      html: ''
    },
  };

  // Формируем html для каждой группы
  for (const [key, val] of Object.entries(fields)) {
    for (const groupName in groups) {
      if (groups[groupName].fields.includes(key) && val[2]) {
        groups[groupName].html += `<p style="margin:0;"><strong>${val[0]}:</strong> ${val[2]}</p>\r\n`;
      }
    }
  }

  // Формируем итоговое письмо
  let html = `<html><body style='font-family:Arial,sans-serif;'>`;
  html += `<h2>Вам поступила новая заявка с сайта "chat.krasnodar-naves.ru"</h2>\r\n`;
  html += '<b>Дата:</b> ' + new Date().toLocaleString('ru-RU') + '<br>';
  for (const sectionTitle in groups) {
    if (groups[sectionTitle].html) {
      html += `<h3 style="font-size: 15px; font-weight: normal; font-style: italic;">${sectionTitle}</h3>`;
      html += groups[sectionTitle].html;
    }
  }
  html += "<p style='font-style: italic; padding: 10px 0 0 0;'>Свяжитесь с потенциальным клиентом в течение 15 минут!</p>";
  html += "</body></html>";

  return html;
}

// ======================
// 🧩 ДОБАВЛЕНО: функция отправки лида в Bitrix24 (универсальная)
// ======================
async function sendLeadToBitrix(data, webhook, fileFieldId, messengerFieldId, webhookName = 'Bitrix') {
  try {
    // Подготавливаем данные для файла (будем загружать после создания лида)
    let fileData = null;
    if (data.chat_history && data.chat_history.trim()) {
      const chatHistoryText = data.chat_history;
      const fileName = `chat_history_${Date.now()}.txt`;
      const fileContentBase64 = Buffer.from(chatHistoryText, 'utf-8').toString('base64');
      
      fileData = {
        fileName: fileName,
        fileContentBase64: fileContentBase64
      };
    }

    const payload = {
      fields: {
        NAME: data.name || '',
        PHONE: [{ VALUE: data.phone || '', VALUE_TYPE: 'WORK' }],
        // Название лида
        TITLE: 'Заявка с сайта chat.krasnodar-naves.ru',
        // UTM метки
        UTM_CAMPAIGN: data.utm_campaign || '',
        UTM_CONTENT: data.utm_content || '',
        UTM_MEDIUM: data.utm_medium || '',
        UTM_SOURCE: data.utm_source || '',
        // Дополнительные поля
        SOURCE_DESCRIPTION: data.page_url || '',
        // Предпочитаемый мессенджер (пользовательское поле)
        [messengerFieldId]: data.messenger || ''
      },
      params: { REGISTER_SONET_EVENT: 'Y' }
    };

    const url = webhook + BITRIX_METHOD;

    // Создаем лид
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    if (response.data?.error) {
      console.error(`❌ [${webhookName}] Ошибка при создании лида:`, response.data.error_description || response.data.error);
      return { success: false, error: response.data.error_description || response.data.error };
    }

    if (!response.data?.result) {
      console.error(`❌ [${webhookName}] Неожиданный ответ Bitrix`);
      return { success: false, error: 'Неожиданный ответ Bitrix' };
    }

    const leadId = response.data.result;
    console.log(`✅ [${webhookName}] Лид создан. ID: ${leadId}`);
    
    // Загружаем файл после создания лида (рабочий формат: fileData работает только при обновлении)
    if (fileData) {
      try {
        const updateUrl = webhook + 'crm.lead.update.json';
        // Рабочий формат для файловых полей в Bitrix24:
        // "UF_CRM_XXXXX": {
        //   "fileData": ["имя_файла.txt", "base64_содержимое"]
        // }
        const updatePayload = {
          id: leadId,
          fields: {
            [fileFieldId]: {
              "fileData": [
                fileData.fileName,
                fileData.fileContentBase64
              ]
            }
          }
        };
        
        const updateResponse = await axios.post(updateUrl, updatePayload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        });

        if (updateResponse.data?.result) {
          console.log(`✅ [${webhookName}] Файл загружен в поле ${fileFieldId}`);
        } else {
          console.warn(`⚠️ [${webhookName}] Не удалось загрузить файл:`, updateResponse.data?.error_description || updateResponse.data?.error);
        }
      } catch (fileError) {
        console.error(`❌ [${webhookName}] Ошибка при загрузке файла:`, fileError.message);
      }
    }
    
    return { success: true, leadId: leadId };
  } catch (err) {
    console.error(`❌ [${webhookName}] Ошибка при отправке лида:`, err.message);
    if (err.response?.data) {
      console.error('   Response:', JSON.stringify(err.response.data, null, 2));
    }
    return { success: false, error: err.response?.data?.error_description || err.message };
  }
}

router.post('/api/send_contact', async (req, res) => {
  const data = req.body;

  const chatHistoryLen = String(data.chat_history || '').trim().length;
  const leadSource = chatHistoryLen > 0 ? 'чат' : 'форма';

  console.log('📥 Входящие данные:', {
    name: data.name,
    phone: data.phone,
    messenger: data.messenger || '—',
    source: leadSource,
    chat_history_chars: chatHistoryLen
  });

  // Простая валидация
  if (!data.name || !data.phone) {
    return res.status(400).json({ error: 'Имя и телефон обязательны' });
  }

  // 0) Telegram отключен (оставлен как шаблон)
  let telegramResult = { success: false, skipped: true, reason: 'Telegram template disabled' };
  if (TELEGRAM_TEMPLATE.ENABLED && TELEGRAM_TEMPLATE.BOT_TOKEN && TELEGRAM_TEMPLATE.CHAT_ID) {
    try {
      telegramResult = await sendLeadToTelegram(data);
      if (telegramResult.success) {
        console.log('Telegram: заявка отправлена успешно');
      }
    } catch (err) {
      telegramResult = { success: false, error: err?.message || 'Telegram send exception' };
    }
  }

  let emailResult = { success: false };
  // 1) Письмо менеджерам
  try {
    emailResult = await sendEmailViaUniSenderGo(data);
    if (emailResult.success) {
      console.log('Письмо: отправлено успешно');
    }
  } catch (err) {
    emailResult = { success: false, error: err?.message || 'Email send exception' };
  }

  let amocrmResult = { success: false };
  // 2) Заявка в amoCRM через парсер почты
  try {
    amocrmResult = await sendLeadToAmoCrmParser(data);
  } catch (err) {
    amocrmResult = { success: false, error: err?.message || 'amoCRM parser send exception' };
  }

  // 3) Лид в Bitrix (шаблон, по умолчанию выключен)
  let bitrixLead = { success: false, skipped: true, reason: 'Bitrix template disabled' };
  if (BITRIX_TEMPLATE.ENABLED && BITRIX_TEMPLATE.WEBHOOK) {
    try {
      bitrixLead = await sendLeadToBitrix(
        data,
        BITRIX_TEMPLATE.WEBHOOK,
        BITRIX_TEMPLATE.FILE_FIELD_ID,
        BITRIX_TEMPLATE.MESSENGER_FIELD_ID,
        'BitrixTemplate'
      );
      if (bitrixLead.success) {
        console.log('Bitrix: лид создан успешно, ID:', bitrixLead.leadId);
      }
    } catch (err) {
      bitrixLead = { success: false, error: err?.message || 'Bitrix lead exception' };
    }
  }

  const successAny = Boolean(
    telegramResult.success || emailResult.success || amocrmResult.success || bitrixLead.success
  );

  console.log('📊 Итог по заявке:', {
    name: data.name,
    source: leadSource,
    telegram: telegramResult.skipped ? 'пропущен' : (telegramResult.success ? 'ok' : 'ошибка'),
    email: emailResult.success ? 'ok' : 'ошибка',
    amocrm: amocrmResult.success ? 'ok' : 'ошибка',
    bitrix: bitrixLead.skipped ? 'выкл' : (bitrixLead.success ? 'ok' : 'ошибка'),
    chat_history_in_amocrm: amocrmResult.historyInBody ?? (chatHistoryLen > 0 ? '?' : 'прочерк')
  });

  return res.status(200).json({
    success: successAny,
    telegram: telegramResult,
    email: emailResult,
    amocrm: amocrmResult,
    bitrixLead: bitrixLead,
    errors: [
      !telegramResult.success && telegramResult.error,
      !emailResult.success && (emailResult.error || emailResult.message),
      !amocrmResult.success && amocrmResult.error,
      !bitrixLead.success && !bitrixLead.skipped && bitrixLead.error
    ].filter(Boolean)
  });
});


module.exports = router;
