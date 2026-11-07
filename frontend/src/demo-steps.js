export const DEMO_DEFAULTS = Object.freeze({
  real: Object.freeze({ chatNa: "p1-ru-001", gross: "p1-ru-022", call: "p4-ru-004", callAlt: "p4-ru-005", appeal: "p1-ru-001" }),
  mock: Object.freeze({ chatNa: "p1-ru-001", gross: "p3-ru-call-014", call: "p3-ru-call-014", callAlt: "p2-ru-call-021", appeal: "p1-ru-001" })
});

export const DEMO_WIDTHS = Object.freeze([768, 1024, 1440, 0]);
export const DEMO_ROLES = Object.freeze(["exec", "reviewer", "operator"]);
export const DEMO_LOCALES = Object.freeze(["ru", "kk", "en"]);

export function demoIds(config, mock) {
  const set = (config && config.demo && config.demo[mock ? "mock" : "real"]) || {};
  const base = DEMO_DEFAULTS[mock ? "mock" : "real"];
  return { ...base, ...set };
}

function card(id) {
  return `#/conversations/${encodeURIComponent(id)}`;
}

export function buildSteps(ids) {
  return [
    { key: "list", minutes: 1, role: "reviewer", hash: "#/conversations", ref: null },
    { key: "na", minutes: 2, role: "reviewer", hash: card(ids.chatNa), ref: ids.chatNa },
    { key: "gross", minutes: 0, role: "reviewer", hash: card(ids.gross), ref: ids.gross },
    { key: "call", minutes: 0, role: "reviewer", hash: card(ids.call), ref: ids.call },
    { key: "appeal", minutes: 1, role: "operator", hash: card(ids.appeal), ref: ids.appeal },
    { key: "decide", minutes: 0, role: "reviewer", hash: "#/appeals", ref: null },
    { key: "total", minutes: 0, role: "reviewer", hash: card(ids.appeal), ref: ids.appeal },
    { key: "builder", minutes: 1, role: "reviewer", hash: "#/checklists", ref: null },
    { key: "runs", minutes: 0, role: "reviewer", hash: "#/runs", ref: null }
  ];
}

export function stepIndexForHash(steps, hash) {
  const normalized = String(hash || "").replace(/\/+$/, "");
  const exact = steps.findIndex((step) => step.hash === normalized);
  if (exact >= 0) return exact;
  return -1;
}

export function frameUrl({ page, role, locale, mock, state, hash }) {
  const query = new URLSearchParams();
  if (mock) query.set("mock", "1");
  if (mock && state) query.set("state", state);
  if (role) query.set("role", role);
  if (locale) query.set("locale", locale);
  const text = query.toString();
  return `${page}${text ? `?${text}` : ""}${hash || ""}`;
}

export const DEMO_TEXT = {
  ru: {
    title: "Демо CQA",
    subtitle: "Пять минут: от списка диалогов до повторного запуска",
    modeMock: "Демо-данные (mock)",
    modeReal: "Рабочий сервер",
    role: "Роль",
    locale: "Язык",
    width: "Ширина",
    widthAuto: "Авто",
    guide: "Сценарий демонстрации",
    open: "Открыть",
    prev: "Назад",
    next: "Далее",
    reset: "Начать заново",
    scale: "масштаб {n}%",
    frameLabel: "Приложение CQA",
    stepOf: "Шаг {n} из {m}",
    current: "Сейчас на экране",
    roles: { exec: "Руководитель", reviewer: "QA / Проверяющий", operator: "Оператор" },
    steps: {
      list: {
        title: "Список диалогов",
        time: "1 мин",
        body: "Оцененный набор DEV: канал, язык, итог, статус апелляции. Покажите фильтры, сортировку по итогу и вид «Грубые нарушения».",
        points: ["Откройте список и отсортируйте по итогу.", "Переключите вид на «Грубые нарушения».", "Выберите диалог для следующего шага."]
      },
      na: {
        title: "Чат с N/A: обоснование и доказательства",
        time: "2 мин",
        body: "Откройте оценку: у критериев с N/A показано условие неприменимости, итог пересчитан без их веса.",
        points: ["Раскройте обоснование критерия.", "Нажмите на цитату: транскрипт прокрутится к сообщению и подсветит его.", "Покажите журнал расчёта итога и строку N/A."]
      },
      gross: {
        title: "Грубое нарушение",
        time: "",
        body: "Флаг грубого нарушения выставляется без баллов, отдельной полосой над итогом.",
        points: ["Найдите полосу «Грубое нарушение» и сообщение-доказательство.", "Перейдите к сообщению по ссылке."]
      },
      call: {
        title: "Голосовой звонок: воспроизведение с места",
        time: "",
        body: "Карточка звонка с плеером: у каждого доказательства есть время, кнопка запускает запись с этого места.",
        points: ["Нажмите «Отсюда» у сообщения или доказательства.", "Попробуйте скорость 1,5× и перемотку стрелками."]
      },
      appeal: {
        title: "Оператор подаёт апелляцию",
        time: "1 мин",
        body: "Роль «Оператор»: выберите критерий с потерянными баллами, нажмите «Оспорить», укажите сообщения и комментарий.",
        points: ["Нажмите «Оспорить» у критерия.", "Отметьте сообщения-доказательства, введите комментарий и отправьте.", "Счётчик апелляций в меню вырастет."]
      },
      decide: {
        title: "QA / Проверяющий решает апелляцию",
        time: "",
        body: "Очередь апелляций: откройте новую, посмотрите оригинальный результат и фрагмент, выберите «Изменить оценку», новый ответ и обязательную причину.",
        points: ["Выберите апелляцию в очереди.", "Сравните предпросмотр итога до и после.", "Сохраните решение с причиной."]
      },
      total: {
        title: "Новый итог в карточке",
        time: "",
        body: "Карточка показывает исходный балл, решение, итоговый балл и пересчитанный итог; оригинал не перезаписан.",
        points: ["Найдите строку исходный → итоговый балл.", "Откройте журнал: добавлена строка решения."]
      },
      builder: {
        title: "Конструктор: заменить критерий",
        time: "1 мин",
        body: "Роль «QA / Проверяющий»: откройте активную версию, замените критерий, проверьте сумму весов (100) и сохраните как новую версию.",
        points: ["Измените критерий и его шкалу.", "Сохраните: появится vN+1, прежние оценки не меняются.", "Нажмите «Применить» для запуска оценки."]
      },
      runs: {
        title: "Запуск и обновлённые результаты",
        time: "",
        body: "Раздел «Запуски»: прогресс повторной оценки, стоимость и ссылка на результаты в списке.",
        points: ["Откройте запуск и дождитесь завершения.", "Вернитесь в список: итоги соответствуют новой версии."]
      }
    }
  },
  kk: {
    title: "CQA демо",
    subtitle: "Бес минут: диалогтар тізімінен қайта іске қосуға дейін",
    modeMock: "Демо деректер (mock)",
    modeReal: "Жұмыс сервері",
    role: "Рөл",
    locale: "Тіл",
    width: "Ені",
    widthAuto: "Авто",
    guide: "Демонстрация сценарийі",
    open: "Ашу",
    prev: "Артқа",
    next: "Алға",
    reset: "Басынан бастау",
    scale: "масштаб {n}%",
    frameLabel: "CQA қолданбасы",
    stepOf: "{m} қадамның {n}-і",
    current: "Қазір экранда",
    roles: { exec: "Басшы", reviewer: "QA / Тексеруші", operator: "Оператор" },
    steps: {
      list: {
        title: "Диалогтар тізімі",
        time: "1 мин",
        body: "Бағаланған DEV жинағы: арна, тіл, қорытынды, апелляция күйі. Сүзгілерді, қорытынды бойынша сұрыптауды және «Өрескел бұзушылықтар» көрінісін көрсетіңіз.",
        points: ["Тізімді ашып, қорытынды бойынша сұрыптаңыз.", "«Өрескел бұзушылықтар» көрінісіне ауысыңыз.", "Келесі қадам үшін диалогты таңдаңыз."]
      },
      na: {
        title: "N/A бар чат: негіздеме және дәлелдер",
        time: "2 мин",
        body: "Бағалауды ашыңыз: N/A критерийлерінде қолданылмау шарты көрсетілген, қорытынды олардың салмағынсыз қайта есептелген.",
        points: ["Критерийдің негіздемесін ашыңыз.", "Дәйексөзді басыңыз: транскрипт хабарламаға айналдырылып, ерекшеленеді.", "Қорытынды есебінің журналын және N/A жолын көрсетіңіз."]
      },
      gross: {
        title: "Өрескел бұзушылық",
        time: "",
        body: "Өрескел бұзушылық белгісі балсыз қойылады, қорытындының үстінде бөлек жолақ ретінде көрсетіледі.",
        points: ["«Өрескел бұзушылық» жолағын және дәлел хабарламаны табыңыз.", "Сілтеме арқылы хабарламаға өтіңіз."]
      },
      call: {
        title: "Дауыстық қоңырау: осы жерден ойнату",
        time: "",
        body: "Плеері бар қоңырау карточкасы: әр дәлелде уақыт бар, батырма жазбаны сол жерден бастайды.",
        points: ["Хабарламада немесе дәлелде «Осыдан» батырмасын басыңыз.", "1,5× жылдамдықты және көрсеткілермен жылжытуды байқаңыз."]
      },
      appeal: {
        title: "Оператор апелляция береді",
        time: "1 мин",
        body: "«Оператор» рөлі: балл жоғалған критерийді таңдап, «Дау айту» батырмасын басыңыз, хабарламаларды және пікірді көрсетіңіз.",
        points: ["Критерийде «Дау айту» батырмасын басыңыз.", "Дәлел хабарламаларды белгілеп, пікір жазып, жіберіңіз.", "Мәзірдегі апелляциялар санағышы артады."]
      },
      decide: {
        title: "QA / Тексеруші апелляцияны шешеді",
        time: "",
        body: "Апелляциялар кезегі: жаңасын ашыңыз, бастапқы нәтижені және үзіндіні қараңыз, «Бағаны өзгерту», жаңа жауап және міндетті себепті таңдаңыз.",
        points: ["Кезектен апелляцияны таңдаңыз.", "Қорытындының алдын ала көрінісін салыстырыңыз.", "Шешімді себебімен сақтаңыз."]
      },
      total: {
        title: "Карточкадағы жаңа қорытынды",
        time: "",
        body: "Карточкада бастапқы балл, шешім, соңғы балл және қайта есептелген қорытынды көрсетіледі; түпнұсқа қайта жазылмайды.",
        points: ["Бастапқы → соңғы балл жолын табыңыз.", "Журналды ашыңыз: шешім жолы қосылған."]
      },
      builder: {
        title: "Конструктор: критерийді ауыстыру",
        time: "1 мин",
        body: "«QA / Тексеруші» рөлі: белсенді нұсқаны ашып, критерийді ауыстырыңыз, салмақ қосындысын (100) тексеріп, жаңа нұсқа ретінде сақтаңыз.",
        points: ["Критерийді және шкаласын өзгертіңіз.", "Сақтаңыз: vN+1 пайда болады, бұрынғы бағалар өзгермейді.", "Бағалауды іске қосу үшін «Қолдану» батырмасын басыңыз."]
      },
      runs: {
        title: "Іске қосу және жаңартылған нәтижелер",
        time: "",
        body: "«Іске қосулар» бөлімі: қайта бағалау барысы, құны және тізімдегі нәтижелерге сілтеме.",
        points: ["Іске қосуды ашып, аяқталуын күтіңіз.", "Тізімге оралыңыз: қорытындылар жаңа нұсқаға сәйкес."]
      }
    }
  },
  en: {
    title: "CQA demo",
    subtitle: "Five minutes: from the conversation list to a re-run",
    modeMock: "Demo data (mock)",
    modeReal: "Live server",
    role: "Role",
    locale: "Language",
    width: "Width",
    widthAuto: "Auto",
    guide: "Demo walkthrough",
    open: "Open",
    prev: "Back",
    next: "Next",
    reset: "Start over",
    scale: "scale {n}%",
    frameLabel: "CQA application",
    stepOf: "Step {n} of {m}",
    current: "Now on screen",
    roles: { exec: "Manager", reviewer: "QA / Reviewer", operator: "Operator" },
    steps: {
      list: {
        title: "Conversation list",
        time: "1 min",
        body: "The evaluated DEV set: channel, language, total, appeal status. Show the filters, sorting by total and the Gross violations view.",
        points: ["Open the list and sort by total.", "Switch to the Gross violations view.", "Pick a conversation for the next step."]
      },
      na: {
        title: "Chat with N/A: rationale and evidence",
        time: "2 min",
        body: "Open the evaluation: N/A criteria show their not-applicable condition and the total is recomputed without their weight.",
        points: ["Expand a criterion rationale.", "Click a quote: the transcript scrolls to the message and highlights it.", "Show the total ledger and the N/A row."]
      },
      gross: {
        title: "Gross violation",
        time: "",
        body: "The gross-violation flag is raised without points, as a separate strip above the total.",
        points: ["Find the Gross violation strip and the evidence message.", "Follow the link to the message."]
      },
      call: {
        title: "Voice call: play from here",
        time: "",
        body: "The call card with a player: every evidence item has a timestamp and the button starts the recording from that point.",
        points: ["Press From here on a message or an evidence item.", "Try 1.5x speed and arrow-key seeking."]
      },
      appeal: {
        title: "The operator files an appeal",
        time: "1 min",
        body: "Operator role: pick a criterion that lost points, press Appeal, select the messages and write a comment.",
        points: ["Press Appeal on a criterion.", "Tick the evidence messages, write a comment and submit.", "The appeals counter in the menu goes up."]
      },
      decide: {
        title: "QA / Reviewer decides",
        time: "",
        body: "The appeal queue: open the new one, see the original result and fragment, choose Change score, a new answer and the mandatory reason.",
        points: ["Select the appeal in the queue.", "Compare the total preview before and after.", "Save the decision with a reason."]
      },
      total: {
        title: "The new total on the card",
        time: "",
        body: "The card shows the original score, the decision, the final score and the recomputed total; the original is never overwritten.",
        points: ["Find the original to final score line.", "Open the ledger: a decision row was added."]
      },
      builder: {
        title: "Builder: replace a criterion",
        time: "1 min",
        body: "QA / Reviewer role: open the active version, replace a criterion, check the weights total 100 and save as a new version.",
        points: ["Edit a criterion and its scale.", "Save: vN+1 appears, earlier scores stay untouched.", "Press Apply to start the evaluation."]
      },
      runs: {
        title: "Run and updated results",
        time: "",
        body: "The Runs section: progress of the re-evaluation, cost and a link to the results in the list.",
        points: ["Open the run and wait for it to finish.", "Return to the list: totals match the new version."]
      }
    }
  }
};

export function demoText(locale) {
  return DEMO_TEXT[locale] || DEMO_TEXT.ru;
}
