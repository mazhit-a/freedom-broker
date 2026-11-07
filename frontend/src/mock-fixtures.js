export const MOCK_EPOCH = "2026-11-07T15:00:00+05:00";

export const OPERATOR_ID = "operator-a";

const SECTIONS = [
  { id: "opening", title: "Начало и понимание запроса", labels: null },
  { id: "security", title: "Безопасность и решение", labels: null },
  { id: "conduct", title: "Ведение и завершение диалога", labels: null },
  { id: "gross", title: "Грубые нарушения", labels: null }
];

const CRITERIA = [
  {
    id: "01",
    title: "Установление контакта",
    description: "Оператор приветствует клиента и представляется по имени в первом сообщении.",
    section: "opening",
    weight: 10,
    type: "yes_no",
    na_allowed: false,
    na_condition: null,
    scale_steps: [],
    max_step: null,
    labels: null
  },
  {
    id: "02",
    title: "Выявление потребности",
    description: "Оператор задаёт уточняющие вопросы, пока запрос клиента не станет однозначным.",
    section: "opening",
    weight: 15,
    type: "yes_no",
    na_allowed: true,
    na_condition: "Клиент сразу сформулировал однозначный запрос.",
    scale_steps: [],
    max_step: null,
    labels: null
  },
  {
    id: "03",
    title: "Идентификация",
    description: "Перед операциями по счёту оператор проверяет личность по регламенту (контрольные вопросы).",
    section: "security",
    weight: 20,
    type: "yes_no",
    na_allowed: true,
    na_condition: "Запрос не касается счёта и персональных данных.",
    scale_steps: [],
    max_step: null,
    labels: null
  },
  {
    id: "04",
    title: "Корректная и полная консультация",
    description: "Ответ верен, полон и соответствует регламентам и тарифам.",
    section: "security",
    weight: 20,
    type: "scale",
    na_allowed: true,
    na_condition: "Запрос не требовал консультации.",
    scale_steps: [
      { value: 0, descriptor: "Неверно" },
      { value: 5, descriptor: "Частично верно, есть ошибки" },
      { value: 10, descriptor: "Верно, существенные пробелы" },
      { value: 15, descriptor: "Корректно, но неполно" },
      { value: 20, descriptor: "Корректно и полно" }
    ],
    max_step: 20,
    labels: null
  },
  {
    id: "05",
    title: "Эмпатия и клиентоориентированность",
    description: "Вежливый тон, признание проблемы клиента, предложение решения под его задачу.",
    section: "conduct",
    weight: 15,
    type: "yes_no",
    na_allowed: false,
    na_condition: null,
    scale_steps: [],
    max_step: null,
    labels: null
  },
  {
    id: "06",
    title: "Управление диалогом, скорость и грамотность",
    description: "Темп ответов, предупреждение о паузах, грамотность речи.",
    section: "conduct",
    weight: 15,
    type: "scale",
    na_allowed: false,
    na_condition: null,
    scale_steps: [
      { value: 0, descriptor: "Хаотично, много ошибок" },
      { value: 4, descriptor: "Несколько нарушений" },
      { value: 7, descriptor: "Одно заметное нарушение" },
      { value: 10, descriptor: "Без замечаний" }
    ],
    max_step: 10,
    labels: null
  },
  {
    id: "07",
    title: "Завершение",
    description: "Оператор уточняет, остались ли вопросы, благодарит и прощается.",
    section: "conduct",
    weight: 5,
    type: "yes_no",
    na_allowed: true,
    na_condition: "Клиент прервал диалог.",
    scale_steps: [],
    max_step: null,
    labels: null
  },
  {
    id: "08",
    title: "Грубые ошибки",
    description: "Запрос кодов и паролей, грубость, обещание доходности, разглашение данных.",
    section: "gross",
    weight: 0,
    type: "flag",
    na_allowed: false,
    na_condition: null,
    scale_steps: [],
    max_step: null,
    labels: null
  }
];

export function makeConfig(name) {
  return JSON.parse(JSON.stringify({ name, sections: SECTIONS, criteria: CRITERIA }));
}

export const CHAT_CHECKLIST_NAME = "Чек-лист качества чатов";
export const CALL_CHECKLIST_NAME = "Чек-лист качества звонков";

export const CHECKLISTS = [
  {
    id: 1,
    name: CHAT_CHECKLIST_NAME,
    channels: ["agent chat"],
    defaultVersionId: 12,
    versions: [
      { id: 11, version: 1, createdAt: "2026-08-01T10:00:00+05:00", status: "saved", appliedCount: 412, firstAppliedAt: "2026-08-12T10:00:00+05:00" },
      { id: 12, version: 2, createdAt: "2026-09-20T10:00:00+05:00", status: "saved", appliedCount: 1248, firstAppliedAt: "2026-10-01T10:00:00+05:00" },
      { id: 13, version: 3, createdAt: "2026-11-07T10:30:00+05:00", status: "draft", appliedCount: 0, firstAppliedAt: null }
    ]
  },
  {
    id: 2,
    name: CALL_CHECKLIST_NAME,
    channels: ["voice call"],
    defaultVersionId: null,
    versions: [{ id: 21, version: 1, createdAt: "2026-11-06T12:00:00+05:00", status: "draft", appliedCount: 0, firstAppliedAt: null }]
  }
];

export const DATASETS = [
  { id: 1, group_id: "control", label: "Контрольная группа", kind: "control", source: "api", source_filename: null, imported_at: "2026-11-05T10:00:00+05:00", conversations: 25, chats: null, calls: null },
  { id: 2, group_id: "DEV", label: "DEV", kind: "dev", source: "api", source_filename: null, imported_at: "2026-11-01T10:00:00+05:00", conversations: 120, chats: null, calls: null }
];

export const MODELS = [
  { id: "llm-v3", label: "LLM-оценщик v3", paid: true, pricePerEvaluation: 0.004, note: "платная" },
  { id: "local", label: "Локальная модель", paid: false, pricePerEvaluation: 0, note: "бесплатно, ниже точность" }
];

function chat(list) {
  return list.map(([t, speaker, text], index) => {
    const [m, s] = t.split(":").map(Number);
    return { message_index: index, timestamp_raw: t, offset_seconds: m * 60 + s, speaker, text };
  });
}

function call(list) {
  return list.map(([at, ts, speaker, text], index) => ({
    message_index: index,
    timestamp_raw: ts,
    offset_seconds: at,
    speaker,
    text,
    audio_start_seconds: at,
    audio_end_seconds: index + 1 < list.length ? list[index + 1][0] : at
  }));
}

export const MESSAGES = {
  "p1-ru-001": chat([
    ["00:00", "system", "Клиент начал чат из личного кабинета"],
    ["00:01", "bot", "Здравствуйте! Я виртуальный помощник Freedom Broker. Опишите, пожалуйста, ваш вопрос."],
    ["00:09", "client", "Здравствуйте. Какая комиссия при покупке американских акций на тарифе «Стандарт»?"],
    ["00:11", "bot", "Перевожу на специалиста. Среднее время ожидания — около минуты."],
    ["00:40", "system", "Оператор подключился к чату"],
    ["00:44", "operator", "Здравствуйте! Меня зовут Айгерим, я помогу разобраться с тарифом."],
    ["00:58", "operator", "Уточните, пожалуйста: вы покупаете акции через мобильное приложение или через веб-терминал? И как часто планируете сделки?"],
    ["01:20", "client", "Через приложение, примерно раз в месяц, на 300–500 долларов."],
    ["01:26", "operator", "Спасибо, минуту."],
    ["03:31", "client", "Вы здесь?"],
    ["04:02", "operator", "Да, извините за ожидание. На тарифе «Стандарт» комиссия по акциям США — процент от суммы сделки плюс фиксированная плата за поручение. Точные значения указаны в приложении: Профиль → Тарифы."],
    ["04:20", "operator", "При вашем объёме может быть выгоднее тариф с фиксированной ежемесячной платой — сравнение есть в том же разделе."],
    ["04:51", "client", "Всё понятно, спасибо, больше вопросов нет."],
    ["04:58", "operator", "Хорошего дня!"],
    ["05:05", "system", "Чат завершён оператором"]
  ]),
  "p3-ru-call-014": call([
    [0, "2026-11-05T14:02:05+05:00", "system", "Входящий звонок · IVR → линия поддержки"],
    [6, "2026-11-05T14:02:11+05:00", "operator", "Freedom Broker, Марат, слушаю вас."],
    [10, "2026-11-05T14:02:15+05:00", "client", "Здравствуйте, не могу войти в приложение, пишет, что пароль неверный."],
    [19, "2026-11-05T14:02:24+05:00", "operator", "Понял. Назовите номер договора."],
    [26, "2026-11-05T14:02:31+05:00", "client", "Договор номер •••• 2219."],
    [43, "2026-11-05T14:02:48+05:00", "operator", "Сейчас вам придёт SMS с кодом, продиктуйте его мне, я сброшу пароль."],
    [54, "2026-11-05T14:02:59+05:00", "client", "Код… а это безопасно — диктовать?"],
    [59, "2026-11-05T14:03:04+05:00", "operator", "Да, всё нормально, диктуйте."],
    [75, "2026-11-05T14:03:20+05:00", "system", "Звонок поставлен на удержание"],
    [156, "2026-11-05T14:04:41+05:00", "operator", "Пароль сброшен, новый придёт в SMS. Всё?"],
    [162, "2026-11-05T14:04:47+05:00", "client", "Ну… да."],
    [164, "2026-11-05T14:04:49+05:00", "system", "Звонок завершён оператором"]
  ])
};

function res(rationale, evidence, extra = {}) {
  return { rationale, evidence, range: null, naReason: null, ...extra };
}

export const RESULTS = {
  "p1-ru-001": {
    "01": res("Оператор поздоровался и представился по имени в первом сообщении после подключения.", [5]),
    "02": res("Задан уточняющий вопрос о способе и частоте сделок; клиент назвал канал, частоту и объём.", [6, 7]),
    "03": res("Операции по счёту и персональные данные в диалоге не затрагивались.", [2], {
      naReason: "Запрос не требовал идентификации — общий вопрос о тарифах, без доступа к счёту и персональным данным."
    }),
    "04": res("Структура комиссии объяснена верно, предложена альтернатива под объём клиента. Не упомянута комиссия за конвертацию валюты, хотя клиент покупает в долларах.", [10, 11]),
    "05": res("Вежливый тон, извинение за ожидание, предложен более выгодный тариф под задачу клиента.", [10, 11]),
    "06": res("Грамотная речь, вопросы по делу. Пауза 2 мин 36 с после обещания «минуту» — клиенту пришлось переспросить.", [8, 9, 10]),
    "07": res("Перед завершением оператор не уточнил, остались ли вопросы, и не поблагодарил за обращение.", [], { range: { from: 12, to: 13 } }),
    "08": res("Грубых нарушений в диалоге не обнаружено.", [])
  },
  "p3-ru-call-014": {
    "01": res("Оператор поздоровался и назвал компанию в первой реплике.", [1]),
    "02": res("Причина обращения выяснена сразу: не удаётся войти в приложение.", [2]),
    "03": res("Проверен только номер договора; вместо контрольных вопросов запрошен код из SMS.", [3, 4, 5]),
    "04": res("Сброс пароля проведён с нарушением процедуры, самостоятельный способ не предложен.", [5, 7]),
    "05": res("Сомнение клиента в безопасности отклонено.", [6, 7]),
    "06": res("Удержание 1 мин 21 с без предупреждения.", [8, 9]),
    "07": res("Перед завершением звонка оператор не уточнил, остались ли вопросы.", [], { range: { from: 9, to: 10 } }),
    "08": res(
      "Оператор попросил клиента продиктовать одноразовый код из SMS и после сомнений клиента настоял на этом. Сотрудники не запрашивают коды подтверждения ни при каких обстоятельствах.",
      [5, 7]
    )
  }
};

export const ROWS = [
  {
    pk: 1,
    id: "p1-ru-001",
    channel: "agent chat",
    language: "RU",
    versionNumber: 2,
    evaluatedAt: "2026-11-07T09:42:00+05:00",
    answers: { "01": "yes", "02": "yes", "03": "na", "04": 15, "05": "yes", "06": 7, "07": "no", "08": "no" }
  },
  {
    pk: 2,
    id: "p1-kz-007",
    channel: "agent chat",
    language: "KZ",
    versionNumber: 2,
    evaluatedAt: "2026-11-07T09:42:00+05:00",
    answers: { "01": "no", "02": "no", "03": "no", "04": 20, "05": "yes", "06": 10, "07": "na", "08": "no" }
  },
  {
    pk: 3,
    id: "p2-en-003",
    channel: "agent chat",
    language: "EN",
    versionNumber: 2,
    evaluatedAt: "2026-11-07T09:43:00+05:00",
    answers: { "01": "yes", "02": "yes", "03": "na", "04": null, "05": "yes", "06": 7, "07": "yes", "08": "no" }
  },
  {
    pk: 4,
    id: "p3-ru-call-014",
    channel: "voice call",
    language: "RU",
    versionNumber: 2,
    evaluatedAt: "2026-11-07T09:44:00+05:00",
    answers: { "01": "yes", "02": "yes", "03": "no", "04": 0, "05": "no", "06": 4, "07": "no", "08": "yes" }
  },
  {
    pk: 5,
    id: "p1-ru-002",
    channel: "agent chat",
    language: "RU",
    versionNumber: 2,
    evaluatedAt: "2026-11-06T17:10:00+05:00",
    answers: { "01": "yes", "02": "yes", "03": "na", "04": 15, "05": "yes", "06": 7, "07": "na", "08": "no" }
  },
  {
    pk: 6,
    id: "p1-kz-011",
    channel: "agent chat",
    language: "KZ",
    versionNumber: 2,
    evaluatedAt: "2026-11-06T17:10:00+05:00",
    answers: { "01": "yes", "02": "yes", "03": "yes", "04": "na", "05": "yes", "06": 4, "07": "yes", "08": "no" }
  },
  {
    pk: 7,
    id: "p2-ru-call-021",
    channel: "voice call",
    language: "RU",
    versionNumber: 1,
    evaluatedAt: "2026-11-04T12:31:00+05:00",
    answers: { "01": "no", "02": "yes", "03": "na", "04": 15, "05": "yes", "06": 7, "07": "na", "08": "no" }
  },
  {
    pk: 8,
    id: "p1-en-009",
    channel: "agent chat",
    language: "EN",
    versionNumber: 2,
    evaluatedAt: "2026-11-04T12:31:00+05:00",
    answers: { "01": "yes", "02": "yes", "03": "yes", "04": 20, "05": "yes", "06": 4, "07": "na", "08": "no" }
  },
  {
    pk: 9,
    id: "p1-ru-015",
    channel: "agent chat",
    language: "RU",
    versionNumber: 2,
    evaluatedAt: "2026-11-04T12:30:00+05:00",
    answers: { "01": "yes", "02": "yes", "03": "yes", "04": 0, "05": "yes", "06": 4, "07": "no", "08": "no" }
  },
  {
    pk: 10,
    id: "p2-kz-call-004",
    channel: "voice call",
    language: "KZ",
    versionNumber: 1,
    evaluatedAt: "2026-11-03T15:02:00+05:00",
    answers: { "01": "yes", "02": "yes", "03": "yes", "04": 5, "05": "yes", "06": 0, "07": "yes", "08": "no" }
  },
  {
    pk: 11,
    id: "p1-ru-019",
    channel: "agent chat",
    language: "RU",
    versionNumber: 2,
    evaluatedAt: "2026-11-07T09:45:00+05:00",
    answers: null,
    failed: true,
    error: "Таймаут модели"
  }
];

export const APPEALS = [
  {
    id: 1,
    rowPk: 1,
    criterionId: "07",
    comment: "Клиент сам написал в 04:51, что вопросов больше нет, поэтому повторно уточнять было излишне. Я попрощалась и завершила чат.",
    refs: [12, 13],
    ageHours: 3,
    reviewStarted: true,
    fragment: [
      { index: 12, time: "04:51", speaker: "client", text: "Всё понятно, спасибо, больше вопросов нет." },
      { index: 13, time: "04:58", speaker: "operator", text: "Хорошего дня!" }
    ]
  },
  {
    id: 2,
    rowPk: 4,
    criterionId: "03",
    comment: "Клиент назвал номер договора, этого достаточно для сброса пароля.",
    refs: [4],
    ageHours: 24,
    reviewStarted: false,
    fragment: [
      { index: 3, time: "14:02:24", speaker: "operator", text: "Понял. Назовите номер договора." },
      { index: 4, time: "14:02:31", speaker: "client", text: "Договор номер •••• 2219." },
      { index: 5, time: "14:02:48", speaker: "operator", text: "Сейчас вам придёт SMS с кодом, продиктуйте его мне, я сброшу пароль." }
    ]
  },
  {
    id: 3,
    rowPk: 2,
    criterionId: "02",
    comment: "Мен 00:37-де «Қай банк арқылы аударасыз?» деп нақтыладым — қажеттілік анықталды. Модель бұл сұрақты ескермеген.",
    refs: [5, 6],
    ageHours: 96,
    reviewStarted: false,
    original: { rationale: "Оператор не уточнил, каким способом клиент хочет пополнить счёт, и сразу дал общую инструкцию." },
    fragment: [
      { index: 4, time: "00:21", speaker: "client", text: "Сәлеметсіз бе! Шотыма ақшаны қалай салуға болады?" },
      { index: 5, time: "00:37", speaker: "operator", text: "Қай банк арқылы аударасыз — Kaspi әлде басқа банк пе?" },
      { index: 6, time: "00:52", speaker: "client", text: "Басқа банктен, карта арқылы." }
    ]
  },
  {
    id: 4,
    rowPk: 5,
    criterionId: "04",
    comment: "Сроки названы в 02:10 отдельным сообщением.",
    refs: [7],
    ageHours: 48,
    reviewStarted: true,
    original: { rationale: "Не названы сроки зачисления дивидендов." },
    fragment: [{ index: 7, time: "02:10", speaker: "operator", text: "Дивиденды зачисляются в течение 3–5 рабочих дней после даты выплаты эмитентом." }],
    decision: "change",
    newAnswer: 20,
    reason: "Сроки названы корректно в 02:10, модель не связала сообщения. Оценка изменена.",
    decidedAt: "2026-11-06T17:40:00+05:00"
  },
  {
    id: 5,
    rowPk: 7,
    criterionId: "06",
    comment: "Система не позволяла быстрее получить ответ из бэк-офиса.",
    refs: [9],
    ageHours: 72,
    reviewStarted: true,
    original: { rationale: "Удержание 2 мин без предупреждения о длительности." },
    fragment: [{ index: 9, time: "12:14:03", speaker: "operator", text: "Подождите, пожалуйста." }],
    decision: "confirm",
    newAnswer: null,
    reason: "По стандарту клиента предупреждают о длительности удержания и возвращаются каждые 60 с. Нарушение подтверждено.",
    decidedAt: "2026-11-05T10:15:00+05:00"
  }
];

export const OVERVIEW = {
  period: { basis: "evaluation_date", from: "2026-10-01", to: "2026-11-07", previous_from: "2026-08-25", previous_to: "2026-09-30" },
  kpis: {
    avg: 78.42,
    delta: 1.84,
    previous_avg: 76.58,
    evaluated: 1248,
    not_calculated: 0,
    chats: 1034,
    calls: 214,
    gross_count: 42,
    gross_share: 3.4,
    open_appeals: 17,
    older_than_hours: 5,
    aging_hours: 72,
    median_resolution_days: 1.6,
    target_days: 2
  },
  distribution: [4, 6, 11, 19, 38, 74, 162, 301, 392, 241].map((count, i) => ({ range_from: i * 10, range_to: i * 10 + 10, count })),
  per_criterion: [
    { criterion_id: "07", title: "Завершение", avg_percent: 61, applicable_count: 1100 },
    { criterion_id: "04", title: "Корректная консультация", avg_percent: 68, applicable_count: 1180 },
    { criterion_id: "06", title: "Управление диалогом", avg_percent: 72, applicable_count: 1248 },
    { criterion_id: "03", title: "Идентификация", avg_percent: 79, applicable_count: 640 },
    { criterion_id: "02", title: "Выявление потребности", avg_percent: 84, applicable_count: 900 },
    { criterion_id: "05", title: "Эмпатия", avg_percent: 88, applicable_count: 1248 },
    { criterion_id: "01", title: "Установление контакта", avg_percent: 95, applicable_count: 1248 }
  ],
  by_language: [
    { language: "RU", count: 812, avg: 79.1, gross_share: 3.1, gross_count: 25 },
    { language: "KZ", count: 286, avg: 75.84, gross_share: 4.5, gross_count: 13 },
    { language: "EN", count: 150, avg: 80.02, gross_share: 2.7, gross_count: 4 }
  ],
  by_channel: [
    { channel: "agent chat", count: 1034, avg: 79.36, gross_share: 2.8, gross_count: 29 },
    { channel: "voice call", count: 214, avg: 73.88, gross_share: 6.1, gross_count: 13 }
  ]
};

export const RUN_ITEMS_R0412 = [
  { rowPk: 1, status: "completed", latencyMs: 6200 },
  { rowPk: 2, status: "completed", latencyMs: 7900, patch: { "02": "yes" } },
  { rowPk: 3, status: "needs_review", latencyMs: 9400 },
  { rowPk: 4, status: "completed", latencyMs: 12100 },
  { rowPk: 11, status: "failed", latencyMs: 30000, error: "Таймаут модели" },
  { rowPk: 7, status: "running", latencyMs: 4000 },
  { rowPk: 8, status: "running", latencyMs: 1800 },
  { rowPk: 10, status: "queued", latencyMs: null }
];

export const RUN_HISTORY = [
  {
    number: 411,
    groupId: "control",
    datasetLabel: "Контрольная группа",
    versionId: 12,
    checklistLabel: "v2",
    model: "LLM-оценщик v3",
    status: "completed",
    total: 25,
    averageTotal: 74.36,
    cost: 0.1,
    startedAt: "2026-11-07T09:40:00+05:00",
    finishedAt: "2026-11-07T09:44:00+05:00"
  },
  {
    number: 407,
    groupId: "DEV",
    datasetLabel: "DEV",
    versionId: 12,
    checklistLabel: "v2",
    model: "LLM-оценщик v3",
    status: "completed",
    total: 120,
    averageTotal: 78.91,
    cost: 0.48,
    startedAt: "2026-11-06T17:05:00+05:00",
    finishedAt: "2026-11-06T17:15:00+05:00"
  },
  {
    number: 388,
    groupId: "export_okt.json",
    datasetLabel: "Файл · export_okt.json",
    versionId: 11,
    checklistLabel: "v1",
    model: "Локальная модель",
    status: "completed",
    total: 412,
    averageTotal: 76.04,
    cost: 0,
    startedAt: "2026-10-12T11:20:00+05:00",
    finishedAt: "2026-10-12T12:40:00+05:00"
  }
];
