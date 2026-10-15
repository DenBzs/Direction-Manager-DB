// 🪄전개지시M 확장 - direction 플레이스홀더 관리 (컴팩트 UI 전용)
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";
import { Popup } from "../../../popup.js";

const extensionName = "Direction-Manager-DB";
const LOG_PREFIX = "[🪄전개지시M]";
// 실제로 설치된 폴더 경로. 폴더명이 달라도(예: Ptest) settings.html을 이 폴더에서 읽기 위함
const extensionFolderUrl = new URL(".", import.meta.url).pathname;

const DEFAULT_DIRECTION_PROMPT_CHAT = `<direction>
- Resume the story based on the director's instructions below.
- The director only provides drafts; refine them into natural prose instead of directly quoting the sentences.
- Creatively construct and fill in any parts lacking persuasive causality so that the narrative suggested by the director unfolds smoothly.

[Direction(If blank, develop the story as you see fit): {{direction}}]
</direction>`;

const DEFAULT_DIRECTION_PROMPT_GLOBAL = `<format_rules>
- These are standing formatting/style rules for every reply in this roleplay. Follow them exactly, without exception, for as long as they are enabled below.
- Do not quote or restate these rules in your reply; just apply them silently.

{{direction}}
</format_rules>`;

const DEFAULT_DIRECTION_PROMPT_CHAR = `<character_notes>
- The following are background notes about the characters' current state and the world (situation, emotions, personality, setting).
- Keep them in mind as quiet background knowledge while writing. They do not need to show up in every reply.
- Never state, quote, or explain these notes directly. Let them surface only indirectly, through tone, behavior, and small details, and only when it fits the scene.

{{direction}}
</character_notes>`;

const DEFAULT_DIRECTION_PROMPT_PLOT_MAIN = `<story_direction>
- The following is the long-term outline of where this story is heading. None of it has happened yet.
- Treat it as background knowledge only. Do not rush toward it, and do not write its ending until the story has genuinely built up to it or the user explicitly directs it.
- Neither rush nor stall: every reply should move the story forward at least a little, without repeating the same situation.
- Never quote or announce this outline.

{{direction}}
</story_direction>`;

const DEFAULT_DIRECTION_PROMPT_PLOT_NEXT = `<next_beats>
- The following are the upcoming events planned for the next few replies, in order. None of them has happened yet.
- Skip any beat already covered in the chat history and continue from the first beat that has not been written yet.
- In a single reply, write only one scene (or part of one) from that first unwritten beat. Never cover several beats in one reply, and never write, hint at, or resolve the beats that come after it.
- End the reply at a natural pause that leaves room for the next beat to follow.
- When every beat has been written, keep moving slowly toward the long-term outline (if one is given), one scene at a time, without jumping ahead.

{{direction}}
</next_beats>`;

// v5까지의 캐릭터 기본 프롬프트 (v6 마이그레이션에서 "기본값 그대로인지" 비교용)
const LEGACY_CHAR_PROMPT_V5 = `<character_notes>
- The following are ongoing notes about the current situation, emotions, personality, or world details that apply to this conversation for the next several turns.
- Treat them as established fact and weave them naturally into the story; do not quote them directly or announce that you received notes.

{{direction}}
</character_notes>`;

// v4 이전 단일 프롬프트 시절의 기본값 (v5 마이그레이션 비교용)
const DEFAULT_DIRECTION_PROMPT = DEFAULT_DIRECTION_PROMPT_CHAT;

const DEFAULT_DIRECTION_PROMPTS = {
    global: DEFAULT_DIRECTION_PROMPT_GLOBAL,
    char: DEFAULT_DIRECTION_PROMPT_CHAR,
    plotMain: DEFAULT_DIRECTION_PROMPT_PLOT_MAIN,
    plotNext: DEFAULT_DIRECTION_PROMPT_PLOT_NEXT,
    chat: DEFAULT_DIRECTION_PROMPT_CHAT,
};

function defaultPlaceholderState() {
    return {
        enabled: false,
        entries: [""],
        activeIndex: 0,
        content: "",
    };
}

const SCOPE_LABELS = {
    global: "[Format Rules]",
    char: "[Character Notes]",
    plotMain: "[Story Direction]",
    plotNext: "[Next Beats]",
    chat: "[Director's Note]",
};

// 저장·프롬프트 주입 단위(총 5개). 화면의 탭은 아래 TAB_*로 묶는다.
const SCOPE_ORDER = ["global", "char", "plotMain", "plotNext", "chat"];

// 화면 탭: 줄거리 탭 하나 안에 큰 줄거리(plotMain) / 작은 줄거리(plotNext) 두 칸이 들어 있다.
const TAB_ORDER = ["global", "char", "plot", "chat"];
const TAB_SCOPES = {
    global: ["global"],
    char: ["char"],
    plot: ["plotMain", "plotNext"],
    chat: ["chat"],
};

// 숫자가 작을수록 최신 메시지에 가깝다 (0 = 맨 끝)
const DEFAULT_PROMPT_DEPTHS = { global: 0, char: 2, plotMain: 4, plotNext: 3, chat: 1 };
// v1.6 이전 기본값 (이 값 그대로 쓰던 사람만 새 기본값으로 옮겨 준다)
const LEGACY_PROMPT_DEPTHS_V7 = { global: 2, char: 5, plotMain: 3, plotNext: 1, chat: 0 };

// 줄거리 두 칸은 채팅(대화) 단위로 저장된다. settings 안의 보관함 이름.
const PLOT_STORE = { plotMain: "plotMains", plotNext: "plotNexts" };

const SCOPE_PLACEHOLDERS = {
    default: "Direction 내용을 입력하세요...",
    plotMain: "전체 방향·결말을 적으세요 (모델이 배경으로만 참고해요)",
    plotNext: "앞으로 몇 챗 분량의 사건을 순서대로 적으세요 (구체적일수록 속도가 잘 맞아요)",
};

let lastPlotScope = "plotNext";

function scopeToTab(scope) {
    return TAB_ORDER.find((tab) => TAB_SCOPES[tab].includes(scope)) || "chat";
}

function getTabScopes(scope) {
    return TAB_SCOPES[scopeToTab(scope)];
}

// 채팅·줄거리 탭은 프리셋 줄을 빼고 그만큼 입력칸을 쓴다
function scopeHidesPresets(scope) {
    return scope === "chat" || scopeToTab(scope) === "plot";
}

// 기록에 남는 항목의 최대 개수(현재 보고 있는 칸 포함). 화면에는 N/5로 표시된다.
const HISTORY_TOTAL_MAX = 5;
const HISTORY_MIN_CHARS = 1;
// 구버전 데이터({content, history} 형태) 호환용
const HISTORY_MAX = HISTORY_TOTAL_MAX - 1;

function defaultScopeState() {
    return {
        direction: defaultPlaceholderState(),
    };
}

const defaultSettings = {
    global: defaultScopeState(),
    chars: {},
    chats: {},
    plotMains: {},
    plotNexts: {},
    globals: {},
    presetPins: { global: "", char: "" },
    presets: {
        direction: { global: [], char: [], plotMain: [], plotNext: [], chat: [] },
    },
    extensionEnabled: true,
    directionPrompt: { ...DEFAULT_DIRECTION_PROMPTS },
    // 0: Chat History 끝에 삽입, >0: 끝에서 N번째 위치에 삽입
    promptDepth: { ...DEFAULT_PROMPT_DEPTHS },
    lastScope: "chat",
    _migratedV2: false,
    _migratedV3: false,
    _migratedV4: false,
    _migratedV5: false,
    _migratedV6: false,
    _migratedV7: false,
    _migratedV8: false,
};

let currentScope = "chat";
function textareaHeightGroup(scope) {
    if (scope === "chat") return "chat";
    if (scopeToTab(scope) === "plot") return "plot";
    return "shared";
}
let compactUITextareaHeights = { shared: "", chat: "" };
let chatHeightIsCustom = false;
let resizeCandidateHeight = null;
let cachedPresetRowHeight = 0;

function getScopeTextarea(scope) {
    if (!compactUIPopup) return $();
    return compactUIPopup.find(scope === "plotNext" ? ".dm-compact--textarea-next" : ".dm-compact--textarea-main");
}

function measurePresetRowHeight() {
    if (!compactUIPopup) return 0;

    const presetRow = compactUIPopup.find(".dm-compact--preset-row");

    if (!presetRow.length) return 0;

    const wasHidden = compactUIPopup.hasClass("dm-compact--hide-preset");

    if (wasHidden) {
        compactUIPopup.removeClass("dm-compact--hide-preset");
    }

    const height = presetRow.outerHeight(true) || 0;

    if (wasHidden) {
        compactUIPopup.addClass("dm-compact--hide-preset");
    }

    return height;
}

function defaultTextareaHeightPx() {
    return window.innerWidth <= 480 ? "130px" : "160px";
}

// 채팅 탭은 직접 리사이즈한 적이 없으면 (공용 높이 + 프리셋 줄 높이)로 맞춰 팝업 크기를 동일하게 유지
// 줄거리 탭: 라벨 2줄(18px×2) + 칸 사이 간격(3px×3)을 뺀 만큼을 큰 줄거리 4 : 작은 줄거리 6으로 나눈다
const PLOT_CHROME_PX = 45;
const PLOT_MAIN_HEIGHT_RATIO = 0.4;

// 채팅·줄거리 탭은 직접 리사이즈한 적이 없으면 (공용 높이 + 프리셋 줄 높이)로 맞춰 팝업 크기를 동일하게 유지
function restoreTextareaHeightForCurrentScope() {
    if (!compactUIPopup) return;

    const isPlot = scopeToTab(currentScope) === "plot";
    const textarea = getScopeTextarea(isPlot ? "plotMain" : currentScope);

    if (!textarea.length) return;

    const sharedPx = parseFloat(compactUITextareaHeights.shared || defaultTextareaHeightPx())
        || parseFloat(defaultTextareaHeightPx());

    if (isPlot) {
        const total = Math.max(110, Math.round(sharedPx + cachedPresetRowHeight - PLOT_CHROME_PX));
        const mainPx = Math.round(total * PLOT_MAIN_HEIGHT_RATIO);
        textarea[0].style.height = `${mainPx}px`;
        getScopeTextarea("plotNext")[0].style.height = `${total - mainPx}px`;
        return;
    }

    if (currentScope === "chat" && !chatHeightIsCustom) {
        textarea[0].style.height = `${Math.round(sharedPx + cachedPresetRowHeight)}px`;
        return;
    }

    const group = textareaHeightGroup(currentScope);
    textarea[0].style.height = compactUITextareaHeights[group] || defaultTextareaHeightPx();
}

// 팝업을 열 때 한 번만 계산. 키보드 상태와 무관하게 screen.availHeight 기준.
function applyTextareaHeightCap() {
    if (!compactUIPopup) return;

    const textarea = compactUIPopup.find(".dm-compact--textarea");

    if (!textarea.length) return;

    const header = compactUIPopup.find(".dm-compact--header");
    const scopeRow = compactUIPopup.find(".dm-compact--scope-row");

    const chromeHeight =
        (header.outerHeight(true) || 0) +
        (scopeRow.outerHeight(true) || 0) +
        cachedPresetRowHeight +
        16;

    const viewportBasis = (window.screen && window.screen.availHeight) || window.innerHeight;
    const viewportBudget = viewportBasis * (window.innerWidth <= 480 ? 0.55 : 0.6);
    const maxTextareaHeight = Math.max(110, Math.round(viewportBudget - chromeHeight));

    textarea.css("max-height", `${maxTextareaHeight}px`);
}
// 타이핑 도중(팝업이 최신 칸을 보고 있을 때) "이번 세션을 시작하기 전 내용"을 기억해둔다.
// 팝업을 닫거나 범위를 바꿀 때, 이 스냅샷을 현재 칸 "바로 앞"에 끼워 넣어 새 기록으로 확정한다.
// entries의 순서 자체는 절대 바뀌지 않는다 — 탐색은 activeIndex만 움직인다.
let sessionSnapshot = null;

function isMeaningfulHistoryText(text) {
    return typeof text === "string" && text.replace(/\s/g, "").length >= HISTORY_MIN_CHARS;
}

function capEntries(entries) {
    if (entries.length > HISTORY_TOTAL_MAX) {
        entries.splice(0, entries.length - HISTORY_TOTAL_MAX);
    }
    return entries;
}

// 팝업을 열거나(스코프 전환 포함) ←/→로 위치를 옮긴 직후 호출: 지금 위치를 새 세션의 기준점으로 삼는다.
function beginHistorySession(scopedValue) {
    const lastIndex = scopedValue.entries.length - 1;
    sessionSnapshot = scopedValue.activeIndex === lastIndex ? scopedValue.entries[lastIndex] : null;
}

// 팝업 닫기 / 범위 전환 직전: 세션 시작 시점 내용이 지금과 다르면 새 기록 한 칸으로 확정한다.
function flushHistorySession() {
    if (sessionSnapshot === null) return;

    if (!compactUIPopup) {
        sessionSnapshot = null;
        return;
    }

    const placeholder = getPopupCurrentPlaceholder();
    const scopedValue = getCurrentScopeState(placeholder.key);
    const lastIndex = scopedValue.entries.length - 1;

    if (scopedValue.activeIndex === lastIndex) {
        const currentText = scopedValue.entries[lastIndex];

        if (currentText !== sessionSnapshot && isMeaningfulHistoryText(sessionSnapshot)) {
            scopedValue.entries.splice(lastIndex, 0, sessionSnapshot);
            capEntries(scopedValue.entries);
            scopedValue.activeIndex = scopedValue.entries.length - 1;
            scopedValue.content = scopedValue.entries[scopedValue.activeIndex];

            if (setCurrentScopeState(placeholder.key, scopedValue)) {
                saveSettingsDebounced();
            }
        }
    }

    sessionSnapshot = null;
}

// ←/→: 목록 순서는 그대로 두고 보고 있는 위치(activeIndex)만 옮긴다. 이 위치는 저장되어
// 팝업을 닫았다 다시 열어도 유지된다.
function navigateHistory(direction) {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const scopedValue = getCurrentScopeState(placeholder.key);
    const target = scopedValue.activeIndex + direction;

    if (target < 0 || target >= scopedValue.entries.length) return;

    scopedValue.activeIndex = target;
    scopedValue.content = scopedValue.entries[target];

    if (!setCurrentScopeState(placeholder.key, scopedValue)) {
        console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
        return;
    }

    getScopeTextarea(currentScope).val(scopedValue.content);
    beginHistorySession(scopedValue);
    applyPlaceholderToSystem(placeholder);
    saveSettingsDebounced();
    updateAppliedIndicator();
    refreshPresetControls();
}
// ST 네이티브 Popup이 떠 있는 동안 true (바깥 클릭으로 컴팩트 UI가 닫히지 않게 함)
let isNativePopupOpen = false;
let compactUIApplyDebounceTimer = null;
let promptEditorScope = "global";
// 확장 설정 패널에서 고쳤지만 아직 저장하지 않은 프롬프트(범위별)
let promptDrafts = {};

const placeholders = [
    { key: "direction", name: "🪄전개지시M", isCustom: true },
];

let compactUIButton = null;
let compactUIPopup = null;

function cloneSettings(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function getSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    return extension_settings[extensionName];
}

function sanitizePlaceholderValue(value) {
    let entries;

    if (Array.isArray(value?.entries) && value.entries.length) {
        entries = value.entries.filter((item) => typeof item === "string");
    } else {
        // 구버전({content, history} 또는 {content, previousContent}) 호환:
        // 예전 history는 "현재 내용 제외, 오래된 것 → 최신" 순서였으므로 그대로 앞에 붙이고
        // content를 맨 뒤(최신)에 둔다.
        let oldHistory = [];

        if (Array.isArray(value?.history)) {
            oldHistory = value.history.filter((item) => typeof item === "string" && item).slice(-HISTORY_MAX);
        } else if (typeof value?.previousContent === "string" && value.previousContent) {
            oldHistory = [value.previousContent];
        }

        entries = [...oldHistory, typeof value?.content === "string" ? value.content : ""];
    }

    if (!entries.length) entries = [""];
    capEntries(entries);

    let activeIndex = Number.isInteger(value?.activeIndex) ? value.activeIndex : entries.length - 1;
    activeIndex = Math.min(Math.max(activeIndex, 0), entries.length - 1);

    return {
        enabled: Boolean(value?.enabled),
        entries,
        activeIndex,
        content: entries[activeIndex],
    };
}

function sanitizeScopeState(scopeState) {
    const source = scopeState || {};
    return {
        direction: sanitizePlaceholderValue(source.direction),
        presetId: typeof source.presetId === "string" ? source.presetId : "",
    };
}

function sanitizePresetList(arr) {
    return Array.isArray(arr)
        ? arr
            .filter(item => item && typeof item.content === "string")
            .map(item => ({
                id: typeof item.id === "string" && item.id ? item.id : `${Date.now()}-${Math.random()}`,
                name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "이름 없는 프리셋",
                content: item.content,
            }))
        : [];
}

function sanitizeScopePresets(scopePresets) {
    const src = scopePresets || {};

    return {
        global: sanitizePresetList(src.global),
        char: sanitizePresetList(src.char),
        plotMain: sanitizePresetList(src.plotMain),
        plotNext: sanitizePresetList(src.plotNext),
        chat: sanitizePresetList(src.chat),
    };
}

function sanitizePresets(presets) {
    const src = presets || {};

    return {
        direction: sanitizeScopePresets(src.direction),
    };
}

function pruneRemovedPlaceholders() {
    const settings = getSettings();
    let changed = false;

    const dropLegacyKeys = (obj) => {
        if (!obj || typeof obj !== "object") return;

        ["char", "user"].forEach((key) => {
            if (key in obj) {
                delete obj[key];
                changed = true;
            }
        });
    };

    dropLegacyKeys(settings.global);
    Object.values(settings.chars || {}).forEach(dropLegacyKeys);
    Object.values(settings.chats || {}).forEach(dropLegacyKeys);
    dropLegacyKeys(settings.presets);
    dropLegacyKeys(settings);

    return changed;
}

function normalizePromptDepth(raw) {
    // 구버전: 숫자 하나를 모든 범위에 공통 적용했음 (줄거리 두 칸은 이 시절에 없었으므로 새 기본값 사용)
    if (Number.isInteger(raw)) {
        return {
            ...DEFAULT_PROMPT_DEPTHS,
            global: raw,
            char: raw,
            chat: raw,
        };
    }

    const src = raw && typeof raw === "object" ? raw : {};
    const result = {};

    SCOPE_ORDER.forEach((scope) => {
        result[scope] = Number.isInteger(src[scope]) ? src[scope] : DEFAULT_PROMPT_DEPTHS[scope];
    });

    return result;
}

function getScopeDepth(scope) {
    const depth = getSettings().promptDepth;
    return Number.isInteger(depth?.[scope]) ? depth[scope] : DEFAULT_PROMPT_DEPTHS[scope];
}

function normalizeDirectionPromptObject(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const result = {};

    SCOPE_ORDER.forEach((scope) => {
        result[scope] = typeof src[scope] === "string" ? src[scope] : DEFAULT_DIRECTION_PROMPTS[scope];
    });

    return result;
}

function isGroupContext(context) {
    return Boolean(context?.groupId ?? context?.selected_group ?? context?.group?.id ?? context?.is_group);
}

function getCharAvatarKey() {
    const context = getContext();

    if (isGroupContext(context)) {
        return null;
    }

    if (this_chid != null && Array.isArray(characters) && characters[this_chid]) {
        return characters[this_chid].avatar || null;
    }

    return null;
}

function getCurrentCharKey() {
    return getCurrentChatKey();
}

function getCurrentChatName(context) {
    if (!context) return null;

    const candidates = [
        context.chatId,
        context.chatFileName,
        context.chatName,
        context.chat_id,
        context.chat_file,
        context.chat_file_name,
        context.chatMetadata?.file_name,
        context.metadata?.chat_file,
    ];

    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
            return String(candidate);
        }
    }

    return null;
}

function getCurrentChatKey() {
    const context = getContext();
    const chatName = getCurrentChatName(context);

    if (!chatName) {
        return null;
    }

    const groupId = context?.groupId ?? context?.selected_group ?? context?.group?.id;

    if (groupId != null) {
        return `group::${groupId}::${chatName}`;
    }

    const charKey = getCharAvatarKey();

    if (!charKey) {
        return null;
    }

    return `${charKey}::${chatName}`;
}

function getScopeAvailability(scope) {
    if (scope === "global") {
        return { available: true, reason: "" };
    }

    if (!getCurrentChatKey()) {
        return { available: false, reason: "현재 채팅을 찾을 수 없습니다" };
    }

    return { available: true, reason: "" };
}

function normalizeSettings() {
    const settings = getSettings();

    settings.global = sanitizeScopeState(settings.global);
    settings.chars = settings.chars && typeof settings.chars === "object" ? settings.chars : {};
    settings.chats = settings.chats && typeof settings.chats === "object" ? settings.chats : {};
    Object.values(PLOT_STORE).forEach((storeKey) => {
        settings[storeKey] = settings[storeKey] && typeof settings[storeKey] === "object" ? settings[storeKey] : {};
    });
    settings.presets = sanitizePresets(settings.presets);
    settings.globals = settings.globals && typeof settings.globals === "object" ? settings.globals : {};
    const pins = settings.presetPins && typeof settings.presetPins === "object" ? settings.presetPins : {};
    settings.presetPins = {
        global: typeof pins.global === "string" ? pins.global : "",
        char: typeof pins.char === "string" ? pins.char : "",
    };
    settings.extensionEnabled = typeof settings.extensionEnabled === "boolean" ? settings.extensionEnabled : defaultSettings.extensionEnabled;
    settings.directionPrompt = normalizeDirectionPromptObject(settings.directionPrompt);
    settings.promptDepth = normalizePromptDepth(settings.promptDepth);
    settings.lastScope = SCOPE_ORDER.includes(settings.lastScope) ? settings.lastScope : "chat";
    settings._migratedV2 = Boolean(settings._migratedV2);
    settings._migratedV3 = Boolean(settings._migratedV3);
    settings._migratedV4 = Boolean(settings._migratedV4);
    settings._migratedV5 = Boolean(settings._migratedV5);
    settings._migratedV6 = Boolean(settings._migratedV6);
    settings._migratedV7 = Boolean(settings._migratedV7);
    settings._migratedV8 = Boolean(settings._migratedV8);

    Object.keys(settings.globals).forEach((key) => {
        settings.globals[key] = sanitizeScopeState(settings.globals[key]);
    });

    Object.keys(settings.chars).forEach((key) => {
        settings.chars[key] = sanitizeScopeState(settings.chars[key]);
    });

    Object.keys(settings.chats).forEach((key) => {
        settings.chats[key] = sanitizeScopeState(settings.chats[key]);
    });

    Object.values(PLOT_STORE).forEach((storeKey) => {
        Object.keys(settings[storeKey]).forEach((key) => {
            settings[storeKey][key] = sanitizeScopeState(settings[storeKey][key]);
        });
    });
}

function migrateV1SettingsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV2) {
        return false;
    }

    const hasLegacy = ["direction", "char", "user"].some((key) => settings[key] !== undefined);

    if (!hasLegacy) {
        settings._migratedV2 = true;
        return true;
    }

    settings.global = sanitizeScopeState(settings.global);

    if (settings.direction !== undefined) {
        settings.global.direction = sanitizePlaceholderValue(settings.direction);
        delete settings.direction;
    }

    delete settings.char;
    delete settings.user;

    settings._migratedV2 = true;
    console.log(`${LOG_PREFIX} v1 설정을 v2 global 스코프로 마이그레이션했습니다. {{char}}/{{user}} 값은 제거했습니다.`);
    return true;
}

// v2까지 프리셋은 범위 구분 없이 하나 → 세 범위 모두에 복사
function migrateV3PresetsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV3) {
        return false;
    }

    const legacyList = Array.isArray(settings.presets?.direction) ? settings.presets.direction : null;

    if (legacyList && legacyList.length > 0) {
        const cloneWithNewIds = () => legacyList.map((item) => ({
            id: `${Date.now()}-${Math.random()}`,
            name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : "이름 없는 프리셋",
            content: typeof item?.content === "string" ? item.content : "",
        }));

        settings.presets = {
            direction: {
                global: cloneWithNewIds(),
                char: cloneWithNewIds(),
                chat: cloneWithNewIds(),
            },
        };

        console.log(`${LOG_PREFIX} 기존 프리셋 ${legacyList.length}개를 전역/캐릭터/채팅 범위 각각에 복사했습니다.`);
    }

    settings._migratedV3 = true;
    return true;
}

// v3까지 캐릭터 범위는 캐릭터 카드 단위로 저장됨 → v4부터 채팅 단위. 옮길 방법이 없어 예전 데이터 정리
function migrateV4LegacyCharScopeIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV4) {
        return false;
    }

    let removed = 0;

    Object.keys(settings.chars || {}).forEach((key) => {
        if (!key.includes("::")) {
            delete settings.chars[key];
            removed += 1;
        }
    });

    settings._migratedV4 = true;

    if (removed > 0) {
        console.log(`${LOG_PREFIX} 캐릭터 범위가 채팅 단위로 바뀌면서, 캐릭터 전체 공용으로 저장돼 있던 예전 데이터 ${removed}개를 정리했습니다.`);
    }

    return true;
}

// v4까지 프롬프트는 문자열 하나 → 범위별 객체로 변경. 커스텀했던 값은 "채팅" 범위로 이전
function migrateV5DirectionPromptIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV5) {
        return false;
    }

    if (typeof settings.directionPrompt === "string") {
        const legacy = settings.directionPrompt;
        settings.directionPrompt = { ...DEFAULT_DIRECTION_PROMPTS };

        if (legacy && legacy.trim() !== "" && legacy !== DEFAULT_DIRECTION_PROMPT) {
            settings.directionPrompt.chat = legacy;
        }

        console.log(`${LOG_PREFIX} Direction 프롬프트가 범위별 템플릿으로 나뉘었습니다. 기존 프롬프트는 "채팅" 범위로 옮겼습니다.`);
    }

    settings._migratedV5 = true;
    return true;
}

// v6: 줄거리 탭(큰 줄거리/작은 줄거리) 추가.
// - 캐릭터 프롬프트가 예전 기본값 그대로면 "은은하게 참고" 새 기본값으로 교체
// - Depth가 예전 기본값(전부 1) 그대로면 새 기본값으로 교체 (직접 바꾼 값은 건드리지 않음)
function migrateV6PlotScopesIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV6) {
        return false;
    }

    const prompts = settings.directionPrompt;

    if (prompts && typeof prompts === "object" && prompts.char === LEGACY_CHAR_PROMPT_V5) {
        prompts.char = DEFAULT_DIRECTION_PROMPT_CHAR;
    }

    const depth = settings.promptDepth;

    if (depth && typeof depth === "object"
        && depth.global === 1 && depth.char === 1 && depth.chat === 1
        && depth.plotMain === undefined && depth.plotNext === undefined) {
        settings.promptDepth = { ...DEFAULT_PROMPT_DEPTHS };
    }

    settings._migratedV6 = true;
    console.log(`${LOG_PREFIX} 줄거리 탭이 추가되었습니다. (예전 기본값을 쓰던 캐릭터 프롬프트/Depth는 새 기본값으로 교체)`);
    return true;
}

// v7: 전역 프리셋에 "기본"(고정) 프리셋을 둔다. 채팅방마다 고른 프리셋을 따로 기억하고,
// 고른 적 없는 채팅방은 고정된 프리셋으로 열린다. 지금까지 쓰던 전역 내용이 그대로 "기본"이 된다.
function migrateV7DefaultPresetIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV7) {
        return false;
    }

    const list = settings.presets.direction.global;
    const legacyContent = sanitizePlaceholderValue(settings.global?.direction).content || "";
    let pinned = list.find((preset) => preset.content === legacyContent);

    if (!pinned) {
        pinned = { id: generatePresetId(), name: "기본", content: legacyContent };
        list.unshift(pinned);
    }

    settings.presetPins.global = pinned.id;
    settings._migratedV7 = true;
    console.log(`${LOG_PREFIX} 전역 "기본" 프리셋을 만들고 고정했습니다.`);
    return true;
}

// v8: 삽입 위치(Depth) 기본값 변경 (전역 0 / 채팅 1 / 캐릭터 2 / 작은 줄거리 3 / 큰 줄거리 4).
// 예전 기본값 그대로 쓰던 경우에만 새 기본값으로 바꾸고, 직접 바꾼 값은 건드리지 않는다.
function migrateV8DepthDefaultsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV8) {
        return false;
    }

    const depth = settings.promptDepth;
    const isLegacyDefault = depth && typeof depth === "object"
        && Object.keys(LEGACY_PROMPT_DEPTHS_V7).every((scope) => depth[scope] === LEGACY_PROMPT_DEPTHS_V7[scope]);

    if (isLegacyDefault) {
        settings.promptDepth = { ...DEFAULT_PROMPT_DEPTHS };
        console.log(`${LOG_PREFIX} 삽입 위치(Depth)를 새 기본값으로 바꿨습니다.`);
    }

    settings._migratedV8 = true;
    return true;
}

async function loadSettings() {
    const settings = getSettings();

    if (Object.keys(settings).length === 0) {
        Object.assign(settings, cloneSettings(defaultSettings));
    }

    const migrated = migrateV1SettingsIfNeeded();
    const migratedV3 = migrateV3PresetsIfNeeded();
    const migratedV4 = migrateV4LegacyCharScopeIfNeeded();
    const migratedV5 = migrateV5DirectionPromptIfNeeded();
    const migratedV6 = migrateV6PlotScopesIfNeeded();
    const pruned = pruneRemovedPlaceholders();
    normalizeSettings();
    const migratedV7 = migrateV7DefaultPresetIfNeeded();
    const migratedV8 = migrateV8DepthDefaultsIfNeeded();

    if (migrated || migratedV3 || migratedV4 || migratedV5 || migratedV6 || migratedV7 || migratedV8 || pruned) {
        saveSettingsDebounced();
    }
}

// 전역 범위: 켜기/끄기는 모든 채팅방 공통, 내용과 "어떤 프리셋을 열어뒀는지"는 채팅방별.
// 고른 적 없는 채팅방은 고정(📌) 프리셋의 내용으로 열린다.
function getGlobalScoped() {
    const settings = getSettings();
    const shared = sanitizeScopeState(settings.global);
    const key = getCurrentChatKey();

    if (!key) {
        return shared;
    }

    const entry = settings.globals?.[key];
    let direction;
    let presetId = "";

    if (entry) {
        direction = sanitizePlaceholderValue(entry.direction);
        presetId = typeof entry.presetId === "string" ? entry.presetId : "";
    } else {
        const pinned = getPinnedPreset("global");

        if (pinned) {
            direction = sanitizePlaceholderValue({ entries: [pinned.content], activeIndex: 0 });
            presetId = pinned.id;
        } else {
            direction = shared.direction;
        }
    }

    return sanitizeScopeState({
        direction: { ...direction, enabled: shared.direction.enabled },
        presetId,
    });
}

function ensureGlobalScoped() {
    const settings = getSettings();
    settings.global = sanitizeScopeState(settings.global);
    const key = getCurrentChatKey();

    if (!key) {
        return settings.global;
    }

    settings.globals = settings.globals && typeof settings.globals === "object" ? settings.globals : {};

    if (!settings.globals[key]) {
        const current = getGlobalScoped();
        settings.globals[key] = sanitizeScopeState({ direction: current.direction, presetId: current.presetId });
    }

    const entry = sanitizeScopeState(settings.globals[key]);
    settings.globals[key] = entry;

    return {
        get direction() {
            return { ...entry.direction, enabled: settings.global.direction.enabled };
        },
        set direction(value) {
            const next = sanitizePlaceholderValue(value);
            settings.global.direction = sanitizePlaceholderValue({ ...settings.global.direction, enabled: next.enabled });
            entry.direction = { ...next };
        },
        get presetId() {
            return entry.presetId;
        },
        set presetId(value) {
            entry.presetId = typeof value === "string" ? value : "";
        },
    };
}

function ensureScopedSettings(scope) {
    const settings = getSettings();

    if (scope === "global") {
        return ensureGlobalScoped();
    }

    if (scope === "char") {
        const key = getCurrentCharKey();
        if (!key) return null;
        settings.chars[key] = sanitizeScopeState(settings.chars[key]);
        return settings.chars[key];
    }

    if (PLOT_STORE[scope]) {
        const key = getCurrentChatKey();
        if (!key) return null;
        const storeKey = PLOT_STORE[scope];
        settings[storeKey] = settings[storeKey] && typeof settings[storeKey] === "object" ? settings[storeKey] : {};
        settings[storeKey][key] = sanitizeScopeState(settings[storeKey][key]);
        return settings[storeKey][key];
    }

    const key = getCurrentChatKey();
    if (!key) return null;
    settings.chats[key] = sanitizeScopeState(settings.chats[key]);
    return settings.chats[key];
}

function getScopedSettings(scope) {
    const settings = getSettings();

    if (scope === "global") {
        return getGlobalScoped();
    }

    if (scope === "char") {
        const key = getCurrentCharKey();
        if (!key) return null;
        return sanitizeScopeState(settings.chars[key]);
    }

    if (PLOT_STORE[scope]) {
        const key = getCurrentChatKey();
        if (!key) return null;
        return sanitizeScopeState(settings[PLOT_STORE[scope]]?.[key]);
    }

    const key = getCurrentChatKey();
    if (!key) return null;
    return sanitizeScopeState(settings.chats[key]);
}

function getScopedPlaceholder(scope, placeholderKey) {
    const scoped = getScopedSettings(scope);
    if (!scoped) return null;
    return sanitizePlaceholderValue(scoped[placeholderKey]);
}

function isValidEnabledContent(value) {
    return Boolean(value?.enabled && typeof value?.content === "string" && value.content.trim() !== "");
}

function resolveCombinedContent(placeholderKey) {
    const parts = [];
    const activeScopes = [];

    SCOPE_ORDER.forEach((scope) => {
        const value = getScopedPlaceholder(scope, placeholderKey);

        if (isValidEnabledContent(value)) {
            parts.push(`${SCOPE_LABELS[scope]}\n${value.content.trim()}`);
            activeScopes.push(scope);
        }
    });

    return {
        content: parts.join("\n\n"),
        activeScopes,
    };
}

function commitDirectionContentNow(placeholder) {
    clearTimeout(compactUIApplyDebounceTimer);
    compactUIApplyDebounceTimer = null;
    applyPlaceholderToSystem(placeholder);
    updateAppliedIndicator();
}

function applyPlaceholderToSystem(placeholder) {
    const combined = resolveCombinedContent(placeholder.key);

    if (combined.activeScopes.length === 0) {
        removePlaceholderFromSystem(placeholder.key);
        return;
    }

    registerCustomPlaceholder(placeholder.key, combined.content);
}

function registerCustomPlaceholder(key, content) {
    try {
        const context = getContext();

        if (context && context.registerMacro) {
            if (context.unregisterMacro) {
                context.unregisterMacro(key);
            }

            context.registerMacro(key, content || "", `🪄전개지시M: ${key}`);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to register custom placeholder:`, error);
    }
}

function removePlaceholderFromSystem(key) {
    try {
        const context = getContext();

        if (context && context.unregisterMacro) {
            context.unregisterMacro(key);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to remove placeholder from system:`, error);
    }
}

function applyAllPlaceholders() {
    placeholders.forEach((placeholder) => {
        applyPlaceholderToSystem(placeholder);
    });
}

function removeAllPlaceholders() {
    placeholders.forEach((placeholder) => {
        removePlaceholderFromSystem(placeholder.key);
    });
}

function getPopupCurrentPlaceholder() {
    return placeholders[0];
}

function getScopeButtonTitle(scope) {
    const availability = getScopeAvailability(scope);

    if (availability.available) {
        return "";
    }

    return availability.reason;
}

function getCurrentScopeState(placeholderKey) {
    const scoped = getScopedSettings(currentScope);

    if (!scoped) {
        return defaultPlaceholderState();
    }

    return sanitizePlaceholderValue(scoped[placeholderKey]);
}

function setCurrentScopeState(placeholderKey, value) {
    const scoped = ensureScopedSettings(currentScope);

    if (!scoped) {
        return false;
    }

    scoped[placeholderKey] = sanitizePlaceholderValue(value);
    return true;
}

function ensureUsableCurrentScope() {
    const availability = getScopeAvailability(currentScope);

    if (availability.available) {
        return;
    }

    const fallbackOrder = ["chat", "char", "global"];

    for (const scope of fallbackOrder) {
        const available = getScopeAvailability(scope);

        if (available.available) {
            currentScope = scope;
            return;
        }
    }

    currentScope = "global";
}

function refreshScopeButtons() {
    if (!compactUIPopup) return;

    const activeTab = scopeToTab(currentScope);

    TAB_ORDER.forEach((tab) => {
        const btn = compactUIPopup.find(`.dm-compact--scope-btn[data-tab="${tab}"]`);
        const firstScope = TAB_SCOPES[tab][0];
        const availability = getScopeAvailability(firstScope);
        btn.prop("disabled", !availability.available);
        btn.attr("title", getScopeButtonTitle(firstScope));
        btn.toggleClass("dm-compact--scope-btn--active", tab === activeTab);
    });
}

function refreshHistoryButtons() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const scopedValue = getCurrentScopeState(placeholder.key);
    const total = scopedValue.entries.length;
    const idx = scopedValue.activeIndex;

    compactUIPopup.find(".dm-compact--history-prev").prop("disabled", idx <= 0);
    compactUIPopup.find(".dm-compact--history-next").prop("disabled", idx >= total - 1);
    compactUIPopup.find(".dm-compact--history-count").text(`${idx + 1}/${total}`);
}

function getPresetList(placeholderKey, scope) {
    const settings = getSettings();

    if (!settings.presets?.[placeholderKey]?.[scope]) {
        settings.presets = sanitizePresets(settings.presets);
    }

    return settings.presets[placeholderKey]?.[scope] || [];
}

// 📌 고정된 프리셋 (지금은 전역 범위에서만 사용)
function getPinnedPreset(scope) {
    const pinId = getSettings().presetPins?.[scope] || "";
    if (!pinId) return null;
    return getPresetList("direction", scope).find((preset) => preset.id === pinId) || null;
}

// 이 채팅방에서 지금 열어둔 프리셋 id. 저장된 선택 → 고정 프리셋 → (예전 데이터) 내용이 같은 프리셋 순으로 찾는다.
function getSelectedPresetId(scope) {
    const placeholder = getPopupCurrentPlaceholder();
    const list = getPresetList(placeholder.key, scope);
    const scoped = getScopedSettings(scope);
    const storedId = scoped?.presetId || "";

    if (storedId && list.some((preset) => preset.id === storedId)) {
        return storedId;
    }

    const pinned = getPinnedPreset(scope);
    if (pinned) return pinned.id;

    const content = scoped ? sanitizePlaceholderValue(scoped[placeholder.key]).content : "";

    if (content) {
        const matched = list.find((preset) => preset.content === content);
        if (matched) return matched.id;
    }

    return "";
}

function setSelectedPresetId(scope, presetId) {
    const scoped = ensureScopedSettings(scope);
    if (scoped) scoped.presetId = presetId;
}

// 프리셋 내용을 저장(덮어쓰기)하면, 그 프리셋을 열어두고 아직 안 고친 채팅방도 새 내용을 따라가게 한다.
function propagatePresetContent(scope, presetId, oldContent, newContent) {
    const settings = getSettings();
    const store = scope === "global" ? settings.globals : settings.chars;

    Object.values(store || {}).forEach((entry) => {
        if (!entry || entry.presetId !== presetId) return;

        const direction = sanitizePlaceholderValue(entry.direction);
        if (direction.content !== oldContent) return;

        const entries = direction.entries.slice();
        entries[direction.activeIndex] = newContent;
        entry.direction = sanitizePlaceholderValue({ ...direction, entries });
    });
}

function clearPresetReferences(scope, presetId) {
    const settings = getSettings();
    const store = scope === "global" ? settings.globals : settings.chars;

    Object.values(store || {}).forEach((entry) => {
        if (entry && entry.presetId === presetId) entry.presetId = "";
    });
}

// 저장 버튼(💾): 열어둔 프리셋과 내용이 달라지면 불이 켜진다.
function refreshPresetControls() {
    if (!compactUIPopup || scopeHidesPresets(currentScope)) return;

    const placeholder = getPopupCurrentPlaceholder();
    const selectedId = getSelectedPresetId(currentScope);
    const preset = selectedId ? getPresetList(placeholder.key, currentScope).find((item) => item.id === selectedId) : null;
    const dirty = Boolean(preset) && getCurrentScopeState(placeholder.key).content !== preset.content;

    compactUIPopup.find(".dm-compact--preset-save").toggleClass("dm-compact--preset-dirty", dirty);
    compactUIPopup.find(".dm-compact--preset-rename, .dm-compact--preset-delete").prop("disabled", !preset);
}

// 타이핑 중에는 매 글자마다 계산하지 않고, 멈춘 뒤 한 번만 갱신한다 (렉 방지)
let presetControlsTimer = null;

function schedulePresetControlsRefresh() {
    clearTimeout(presetControlsTimer);
    presetControlsTimer = setTimeout(refreshPresetControls, 150);
}

// ---- 프리셋 목록 (직접 만든 드롭다운): 줄마다 이름 · ▲▼(순서 편집 중) · ★(기본 지정) · ◯(선택)
let presetListOpen = false;
let presetReorderMode = false;

function buildPresetListHtml() {
    const placeholder = getPopupCurrentPlaceholder();
    const presets = getPresetList(placeholder.key, currentScope);
    const pinnedId = getPinnedPreset(currentScope)?.id || "";
    const selectedId = getSelectedPresetId(currentScope);
    const canPin = currentScope === "global";

    const rows = presets.map((preset, index) => {
        const isSelected = preset.id === selectedId;
        const isPinned = preset.id === pinnedId;
        const move = presetReorderMode
            ? `<span class="dm-compact--move${index === 0 ? " dm-compact--move-off" : ""}" data-act="up">▲</span><span class="dm-compact--move${index === presets.length - 1 ? " dm-compact--move-off" : ""}" data-act="down">▼</span>`
            : "";
        const star = canPin
            ? `<span class="dm-compact--star${isPinned ? " dm-compact--star-on" : ""}" data-act="pin" title="기본으로 지정">${isPinned ? "★" : "☆"}</span>`
            : "";

        return `<div class="dm-compact--preset-item${isSelected ? " dm-compact--preset-item-sel" : ""}" data-id="${preset.id}">`
            + `<span class="dm-compact--preset-item-name">${escapeHtml(preset.name)}</span>${move}${star}`
            + `<span class="dm-compact--dot${isSelected ? " dm-compact--dot-on" : ""}"></span></div>`;
    }).join("");

    const head = `<div class="dm-compact--preset-list-head"><span>프리셋 ${presets.length}개</span>`
        + `<button type="button" data-act="reorder">${presetReorderMode ? "✔ 완료" : "↕ 순서 편집"}</button></div>`;

    return head + (rows || '<div class="dm-compact--preset-empty">저장된 프리셋이 없어요</div>');
}

function renderPresetList() {
    if (!compactUIPopup) return;

    const list = compactUIPopup.find(".dm-compact--preset-list");
    const scrollTop = list.scrollTop();
    list.html(buildPresetListHtml()).scrollTop(scrollTop);
}

function setPresetListOpen(open) {
    if (!compactUIPopup) return;

    presetListOpen = open;
    if (!open) presetReorderMode = false;

    compactUIPopup.toggleClass("dm-compact--list-open", open);
    compactUIPopup.find(".dm-compact--preset-list").toggleClass("dm-compact--open", open);
    if (open) renderPresetList();
}

function renderPresetSelect() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const selectedId = getSelectedPresetId(currentScope);
    const preset = selectedId ? getPresetList(placeholder.key, currentScope).find((item) => item.id === selectedId) : null;
    const pinnedId = getPinnedPreset(currentScope)?.id || "";
    const star = preset && preset.id === pinnedId ? '<span class="dm-compact--star dm-compact--star-on">★</span>' : "";

    compactUIPopup.find(".dm-compact--preset-current-name").html(preset ? `${star}${escapeHtml(preset.name)}` : "✨️ 어떤 지시를 내릴까?");

    if (presetListOpen) renderPresetList();
    refreshPresetControls();
}

function updateAppliedIndicator() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const combined = resolveCombinedContent(placeholder.key);
    const activeScopes = new Set(combined.activeScopes);

    TAB_ORDER.forEach((tab) => {
        const isOn = TAB_SCOPES[tab].some((scope) => activeScopes.has(scope));
        compactUIPopup
            .find(`.dm-compact--scope-btn[data-tab="${tab}"]`)
            .toggleClass("dm-compact--scope-btn--on", isOn);
    });

    refreshHistoryButtons();
}

// 줄거리 탭에서 지금 편집 중인 칸(큰 줄거리/작은 줄거리)을 강조
function updateActiveFieldHighlight() {
    if (!compactUIPopup) return;

    compactUIPopup.find(".dm-compact--textarea, .dm-compact--plot-label").each(function () {
        $(this).toggleClass("dm-compact--field-active", $(this).attr("data-scope") === currentScope);
    });
}

// 줄거리 탭에서 다른 칸으로 포커스가 옮겨졌을 때: 이전 칸의 기록을 확정하고 헤더(←/→, 체크박스)가 새 칸을 가리키게 한다.
// 입력창 내용은 건드리지 않는다(커서가 튀지 않게).
function switchActiveField(scope) {
    if (!compactUIPopup || scope === currentScope) return;

    flushHistorySession();

    currentScope = scope;

    if (scopeToTab(scope) === "plot") {
        lastPlotScope = scope;
    }

    getSettings().lastScope = scope;
    saveSettingsDebounced();

    const state = getCurrentScopeState(getPopupCurrentPlaceholder().key);
    beginHistorySession(state);
    compactUIPopup.find(".dm-compact--radio").prop("checked", state.enabled);

    updateActiveFieldHighlight();
    updateAppliedIndicator();
}

function syncPopupByCurrentState() {
    if (!compactUIPopup) return;

    ensureUsableCurrentScope();
    setPresetListOpen(false);

    const currentPlaceholder = getPopupCurrentPlaceholder();
    const settings = getCurrentScopeState(currentPlaceholder.key);
    const isPlot = scopeToTab(currentScope) === "plot";
    beginHistorySession(settings);

    compactUIPopup.find(".dm-compact--radio").prop("checked", settings.enabled);
    compactUIPopup.toggleClass("dm-compact--plot-tab", isPlot);

    // 위 칸은 줄거리 탭에서는 큰 줄거리, 다른 탭에서는 현재 범위. 아래 칸은 줄거리 탭에서만 보인다.
    [
        { slot: "main", scope: isPlot ? "plotMain" : currentScope },
        { slot: "next", scope: "plotNext" },
    ].forEach(({ slot, scope }) => {
        const state = getScopedPlaceholder(scope, currentPlaceholder.key) || defaultPlaceholderState();

        compactUIPopup
            .find(`.dm-compact--textarea-${slot}`)
            .attr("data-scope", scope)
            .attr("placeholder", SCOPE_PLACEHOLDERS[scope] || SCOPE_PLACEHOLDERS.default)
            .val(state.content || "")
            .prop("disabled", !settings.enabled);
    });

    compactUIPopup.toggleClass("dm-compact--hide-preset", scopeHidesPresets(currentScope));

    refreshScopeButtons();
    renderPresetSelect();
    updateAppliedIndicator();
    updateActiveFieldHighlight();
}

function generatePresetId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random()}`;
}

async function showNativeConfirm(header, text, popupOptions = {}) {
    isNativePopupOpen = true;

    try {
        return await Popup.show.confirm(header, text, popupOptions);
    } finally {
        isNativePopupOpen = false;
    }
}

async function showNativeInput(header, text, defaultValue = "", popupOptions = {}) {
    isNativePopupOpen = true;

    try {
        return await Popup.show.input(header, text, defaultValue, popupOptions);
    } finally {
        isNativePopupOpen = false;
    }
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function closeCompactUIPopup() {
    if (compactUIApplyDebounceTimer) {
        commitDirectionContentNow(getPopupCurrentPlaceholder());
    }

    flushHistorySession();

    if (compactUIPopup) {
        compactUIPopup.removeClass("dm-compact--active");

        setTimeout(() => {
            if (compactUIPopup) {
                compactUIPopup.remove();
                compactUIPopup = null;
            }
        }, 200);
    }

    if (compactUIButton) {
        // class 대신 data 속성 사용: 서드파티 UI 스크립트가 classList로 버튼을 식별하는 경우 위치 설정이 초기화되는 것을 방지
        compactUIButton.removeAttr("data-dm-popup-open");
    }

    clearTimeout(presetControlsTimer);
    presetListOpen = false;
    presetReorderMode = false;

    $(document).off("click.compactUI");
    $(document).off("mouseup.dmResize touchend.dmResize");
}

function showCompactUIPopup() {
    if (compactUIPopup) {
        return closeCompactUIPopup();
    }

    const settings = getSettings();
    currentScope = settings.lastScope || "chat";
    ensureUsableCurrentScope();

    if (scopeToTab(currentScope) === "plot") {
        lastPlotScope = currentScope;
    }

    compactUIButton.attr("data-dm-popup-open", "true");

    const popupHtml = `
        <div class="dm-compact--popup">
            <div class="dm-compact--header">
                <input type="checkbox" class="dm-compact--radio" title="이 범위 켜기/끄기">
                <div class="dm-compact--title">🪄전개지시M</div>
                <div class="dm-compact--header-spacer"></div>
                <button class="dm-compact--history-btn dm-compact--history-prev" type="button" title="이전 내용 보기">
                    <i class="fa-solid fa-arrow-left"></i>
                </button>
                <span class="dm-compact--history-count"></span>
                <button class="dm-compact--history-btn dm-compact--history-next" type="button" title="다음 내용 보기">
                    <i class="fa-solid fa-arrow-right"></i>
                </button>
                <button class="dm-compact--nav dm-compact--clear" title="내용 지우기" type="button">
                    <i class="fa-solid fa-eraser"></i>
                </button>
            </div>

            <div class="dm-compact--scope-row">
                <button class="dm-compact--scope-btn" data-tab="global" type="button"><span class="dm-compact--scope-emoji">🌐</span>전역</button>
                <button class="dm-compact--scope-btn" data-tab="char" type="button"><span class="dm-compact--scope-emoji">🎭</span>캐릭터</button>
                <button class="dm-compact--scope-btn" data-tab="plot" type="button"><span class="dm-compact--scope-emoji">📖</span>줄거리</button>
                <button class="dm-compact--scope-btn" data-tab="chat" type="button"><span class="dm-compact--scope-emoji">🗨️</span>채팅</button>
            </div>

            <div class="dm-compact--preset-row">
                <button class="dm-compact--preset-current" type="button" title="프리셋 목록 열기">
                    <span class="dm-compact--preset-current-name"></span>
                    <i class="fa-solid fa-caret-down"></i>
                </button>
                <button class="dm-compact--preset-btn dm-compact--preset-save" type="button" title="이 프리셋에 저장 (내용이 바뀌면 불이 켜져요)">
                    <i class="fa-solid fa-floppy-disk"></i>
                </button>
                <button class="dm-compact--preset-btn dm-compact--preset-new" type="button" title="새 프리셋으로 저장">
                    <i class="fa-solid fa-plus"></i>
                </button>
                <button class="dm-compact--preset-btn dm-compact--preset-rename" type="button" title="프리셋 이름 변경">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="dm-compact--preset-btn dm-compact--preset-delete" type="button" title="프리셋 삭제">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <div class="dm-compact--preset-anchor">
                <div class="dm-compact--preset-list"></div>
            </div>

            <div class="dm-compact--content">
                <div class="dm-compact--plot-label dm-compact--plot-only" data-scope="plotMain">📖 큰 줄거리<small>방향·결말</small></div>
                <textarea class="dm-compact--textarea dm-compact--textarea-main" placeholder="Direction 내용을 입력하세요..."></textarea>
                <div class="dm-compact--plot-label dm-compact--plot-only" data-scope="plotNext">🎬 작은 줄거리<small>몇 챗 분량 사건</small></div>
                <textarea class="dm-compact--textarea dm-compact--textarea-next dm-compact--plot-only" placeholder="Direction 내용을 입력하세요..."></textarea>
            </div>
        </div>
    `;

    compactUIPopup = $(popupHtml);
    $("#nonQRFormItems").append(compactUIPopup);

    setTimeout(() => {
        if (compactUIPopup) {
            compactUIPopup.addClass("dm-compact--active");
        }
    }, 10);

    setupCompactUIEventListeners();
    syncPopupByCurrentState();

    cachedPresetRowHeight = measurePresetRowHeight();
    restoreTextareaHeightForCurrentScope();
    applyTextareaHeightCap();
}

function setupCompactUIEventListeners() {
    if (!compactUIPopup) return;

    // touchstart에서 preventDefault로 textarea blur(키보드 닫힘)를 막고 핸들러를 직접 실행한 뒤,
    // 뒤따르는 click은 무시한다(중복 실행 방지). 마우스 환경에서는 click만 사용된다.
    function bindTapAction(selector, handler) {
        let suppressNextClick = false;

        compactUIPopup.on("touchstart", selector, function (e) {
            if ($(this).prop("disabled")) return;
            e.preventDefault();
            suppressNextClick = true;
            setTimeout(() => { suppressNextClick = false; }, 400);
            handler.call(this, e);
        });

        compactUIPopup.on("mousedown", selector, (e) => {
            e.preventDefault();
        });

        compactUIPopup.on("click", selector, function (e) {
            if (suppressNextClick) {
                suppressNextClick = false;
                return;
            }
            handler.call(this, e);
        });
    }

    bindTapAction(".dm-compact--scope-btn", function () {
        const nextTab = String($(this).data("tab"));
        const nextScope = nextTab === "plot" ? lastPlotScope : TAB_SCOPES[nextTab][0];
        const availability = getScopeAvailability(nextScope);

        if (!availability.available) {
            return;
        }

        flushHistorySession();

        // 줄거리 탭의 높이는 항상 공용 높이에서 계산하므로 따로 저장하지 않는다.
        const outgoingGroup = textareaHeightGroup(currentScope);

        if (outgoingGroup !== "plot") {
            const outgoingTextarea = getScopeTextarea(currentScope);
            compactUITextareaHeights[outgoingGroup] = outgoingTextarea.length ? outgoingTextarea[0].style.height : "";
        }

        currentScope = nextScope;
        getSettings().lastScope = nextScope;
        saveSettingsDebounced();
        syncPopupByCurrentState();

        restoreTextareaHeightForCurrentScope();
    });

    bindTapAction(".dm-compact--history-prev", () => navigateHistory(-1));
    bindTapAction(".dm-compact--history-next", () => navigateHistory(1));

    compactUIPopup.find(".dm-compact--radio").on("change", function () {
        const isEnabled = $(this).is(":checked");
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);
        scopedValue.enabled = isEnabled;

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 스코프에 값을 저장하지 못했습니다.`);
            return;
        }

        // 줄거리 탭처럼 한 탭에 두 칸이 있으면 두 칸을 함께 켜고 끈다.
        getTabScopes(currentScope).forEach((scope) => {
            if (scope === currentScope) return;

            const sibling = ensureScopedSettings(scope);

            if (sibling) {
                sibling[currentPlaceholder.key] = sanitizePlaceholderValue({
                    ...sanitizePlaceholderValue(sibling[currentPlaceholder.key]),
                    enabled: isEnabled,
                });
            }
        });

        const textarea = compactUIPopup.find(".dm-compact--textarea");
        textarea.prop("disabled", !isEnabled);

        applyPlaceholderToSystem(currentPlaceholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    // 체크박스도 터치 시 키보드가 닫히므로 직접 토글하고 change를 발생시킨다.
    compactUIPopup.on("touchstart", ".dm-compact--radio", function (e) {
        e.preventDefault();
        const checkbox = $(this);
        checkbox.prop("checked", !checkbox.prop("checked")).trigger("change");
    });

    compactUIPopup.on("mousedown", ".dm-compact--radio", (e) => {
        e.preventDefault();
    });

    // 채팅 탭에서 리사이즈 손잡이를 실제로 드래그했는지 감지 (모서리 근처 터치 + 높이 변화 둘 다 확인)
    compactUIPopup.on("mousedown touchstart", ".dm-compact--textarea", function (e) {
        if (currentScope !== "chat" || chatHeightIsCustom) {
            resizeCandidateHeight = null;
            return;
        }

        const point = (e.originalEvent && e.originalEvent.touches && e.originalEvent.touches[0]) || e.originalEvent || e;
        const rect = this.getBoundingClientRect();
        const nearResizeHandle = rect.right - point.clientX <= 20 && rect.bottom - point.clientY <= 20;

        resizeCandidateHeight = nearResizeHandle ? this.style.height : null;
    });

    $(document).on("mouseup.dmResize touchend.dmResize", () => {
        if (resizeCandidateHeight === null || !compactUIPopup) return;

        const textarea = compactUIPopup.find(".dm-compact--textarea")[0];

        if (textarea && textarea.style.height !== resizeCandidateHeight) {
            chatHeightIsCustom = true;
        }

        resizeCandidateHeight = null;
    });

    bindTapAction(".dm-compact--clear", function () {
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);

        // 지금 목록 순서는 그대로 두고, 맨 뒤에 빈 칸을 새로 추가해서 그 칸으로 이동한다.
        scopedValue.entries.push("");
        capEntries(scopedValue.entries);
        scopedValue.activeIndex = scopedValue.entries.length - 1;
        scopedValue.content = "";
        sessionSnapshot = null;

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
            return;
        }

        getScopeTextarea(currentScope).val("");
        applyPlaceholderToSystem(currentPlaceholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
        refreshPresetControls();
    });

    // 줄거리 탭: 포커스가 옮겨진 칸을 "지금 편집 중인 칸"으로 삼는다
    compactUIPopup.on("focusin", ".dm-compact--textarea", function () {
        const fieldScope = $(this).attr("data-scope");

        if (fieldScope) {
            switchActiveField(fieldScope);
        }
    });

    compactUIPopup.find(".dm-compact--textarea").on("input", function () {
        const fieldScope = $(this).attr("data-scope");

        if (fieldScope && fieldScope !== currentScope) {
            switchActiveField(fieldScope);
        }

        const newContent = String($(this).val());
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);
        const lastIndex = scopedValue.entries.length - 1;

        if (scopedValue.activeIndex !== lastIndex) {
            // 이전 칸을 보다가 수정: 기존 항목들은 그대로 두고 맨 뒤에 새 칸으로 분기한다.
            scopedValue.entries.push(newContent);
            capEntries(scopedValue.entries);
            scopedValue.activeIndex = scopedValue.entries.length - 1;
            sessionSnapshot = null;
        } else {
            scopedValue.entries[lastIndex] = newContent;
        }

        scopedValue.content = scopedValue.entries[scopedValue.activeIndex];

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
            return;
        }

        // 매크로 재등록은 비용이 커서 입력이 250ms 멈췄을 때만 반영
        clearTimeout(compactUIApplyDebounceTimer);
        compactUIApplyDebounceTimer = setTimeout(() => {
            commitDirectionContentNow(currentPlaceholder);
        }, 250);

        saveSettingsDebounced();
        schedulePresetControlsRefresh();
    });

    function selectPreset(preset) {
        const placeholder = getPopupCurrentPlaceholder();

        setSelectedPresetId(currentScope, preset.id);

        // 프리셋을 고르면 ←/→ 기록을 이 프리셋 내용 기준으로 새로 시작한다.
        // (이전에 보던 프리셋의 내용이 기록에 끼어들어 ←로 나오는 것을 막는다)
        const scopedValue = getCurrentScopeState(placeholder.key);
        scopedValue.entries = [preset.content];
        scopedValue.activeIndex = 0;
        scopedValue.content = preset.content;
        setCurrentScopeState(placeholder.key, scopedValue);

        getScopeTextarea(currentScope).val(preset.content);
        beginHistorySession(scopedValue);
        commitDirectionContentNow(placeholder);
        saveSettingsDebounced();
        setPresetListOpen(false);
        renderPresetSelect();
    }

    compactUIPopup.find(".dm-compact--preset-current").on("click", () => setPresetListOpen(!presetListOpen));

    // 목록 안의 모든 동작은 한 곳에서 받는다 (줄마다 리스너를 달지 않는다)
    compactUIPopup.find(".dm-compact--preset-list").on("click", (e) => {
        // 목록을 다시 그리면 눌린 요소가 사라져서 "팝업 바깥을 눌렀다"로 오해받는다 → 여기서 이벤트를 끝낸다
        e.stopPropagation();

        const placeholder = getPopupCurrentPlaceholder();
        const settings = getSettings();
        const list = getPresetList(placeholder.key, currentScope);
        const actEl = $(e.target).closest("[data-act]");
        const act = actEl.length ? String(actEl.data("act")) : "";
        const itemEl = $(e.target).closest(".dm-compact--preset-item");
        const id = itemEl.length ? String(itemEl.data("id")) : "";
        const index = list.findIndex((item) => item.id === id);

        if (act === "reorder") {
            presetReorderMode = !presetReorderMode;
            renderPresetList();
        } else if (act === "pin" && index >= 0) {
            settings.presetPins[currentScope] = id;
            saveSettingsDebounced();
            renderPresetSelect();
        } else if ((act === "up" || act === "down") && index >= 0) {
            const swapWith = index + (act === "up" ? -1 : 1);

            if (swapWith < 0 || swapWith >= list.length) return;

            [list[index], list[swapWith]] = [list[swapWith], list[index]];
            saveSettingsDebounced();
            renderPresetList();
        } else if (index >= 0 && !presetReorderMode) {
            selectPreset(list[index]);
        }
    });

    // 팝업의 다른 곳을 누르면 목록을 닫는다
    compactUIPopup.on("click", (e) => {
        if (presetListOpen && !$(e.target).closest(".dm-compact--preset-list, .dm-compact--preset-current").length) {
            setPresetListOpen(false);
        }
    });

    async function saveCurrentAsNewPreset() {
        const placeholder = getPopupCurrentPlaceholder();
        const textareaValue = String(getScopeTextarea(currentScope).val() || "");
        const name = await showNativeInput("새 프리셋", "새 프리셋 이름을 입력하세요:", "새 프리셋");

        if (!name || !name.trim()) {
            return;
        }

        const preset = { id: generatePresetId(), name: name.trim(), content: textareaValue };
        getPresetList(placeholder.key, currentScope).push(preset);
        setSelectedPresetId(currentScope, preset.id);
        saveSettingsDebounced();
        renderPresetSelect();
    }

    compactUIPopup.find(".dm-compact--preset-save").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const selectedId = getSelectedPresetId(currentScope);
        const preset = selectedId ? getPresetList(placeholder.key, currentScope).find((item) => item.id === selectedId) : null;

        if (!preset) {
            await saveCurrentAsNewPreset();
            return;
        }

        const textareaValue = String(getScopeTextarea(currentScope).val() || "");

        if (textareaValue === preset.content) {
            toastr.info("바뀐 내용이 없어요.");
            return;
        }

        const oldContent = preset.content;
        preset.content = textareaValue;
        propagatePresetContent(currentScope, preset.id, oldContent, textareaValue);
        setSelectedPresetId(currentScope, preset.id);
        saveSettingsDebounced();
        applyAllPlaceholders();
        renderPresetSelect();
        toastr.success(`"${preset.name}" 프리셋에 저장했어요.`);
    });

    compactUIPopup.find(".dm-compact--preset-new").on("click", saveCurrentAsNewPreset);

    compactUIPopup.find(".dm-compact--preset-rename").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const list = getPresetList(placeholder.key, currentScope);
        const target = list.find((item) => item.id === getSelectedPresetId(currentScope));

        if (!target) return;

        const newName = await showNativeInput("프리셋 이름 변경", "새 프리셋 이름을 입력하세요:", target.name);

        if (!newName || !newName.trim()) return;

        target.name = newName.trim();
        saveSettingsDebounced();
        renderPresetSelect();
    });

    compactUIPopup.find(".dm-compact--preset-delete").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const settings = getSettings();
        const list = getPresetList(placeholder.key, currentScope);
        const index = list.findIndex((item) => item.id === getSelectedPresetId(currentScope));

        if (index < 0) return;

        const target = list[index];

        if (settings.presetPins[currentScope] === target.id) {
            toastr.warning("기본(★)으로 지정된 프리셋은 삭제할 수 없어요. 다른 프리셋에 ★를 켠 뒤 삭제해 주세요.");
            return;
        }

        const confirmed = await showNativeConfirm("프리셋 삭제", `"${target.name}" 프리셋을 삭제하시겠습니까? (이 프리셋을 쓰던 채팅방의 내용은 그대로 남아요)`);

        if (!confirmed) return;

        list.splice(index, 1);
        clearPresetReferences(currentScope, target.id);
        saveSettingsDebounced();
        renderPresetSelect();
    });

    $(document).on("click.compactUI", (e) => {
        if (isNativePopupOpen) {
            return;
        }

        // 이미 화면에서 사라진 요소(다시 그려진 목록 줄 등)를 누른 경우는 바깥 클릭이 아니다
        if (!e.target.isConnected) {
            return;
        }

        if (!$(e.target).closest(".dm-compact--popup, .dm-compact--button").length) {
            closeCompactUIPopup();
        }
    });
}

function refreshPopupIfOpened() {
    if (!compactUIPopup) {
        return;
    }

    syncPopupByCurrentState();
}

function addCompactUIButton() {
    const ta = document.querySelector("#send_textarea");

    if (!ta) {
        setTimeout(addCompactUIButton, 1000);
        return;
    }

    if (compactUIButton) {
        compactUIButton.remove();
        compactUIButton = null;
    }

    const buttonHtml = `
        <div class="dm-compact--button menu_button" title="🪄전개지시M 빠른 편집">
            <i class="fa-solid fa-feather"></i>
        </div>
    `;

    compactUIButton = $(buttonHtml);
    $(ta).after(compactUIButton);

    const settings = getSettings();

    if (settings && settings.extensionEnabled) {
        compactUIButton.show();
    } else {
        compactUIButton.hide();
    }

    compactUIButton.on("click", showCompactUIPopup);
}

async function initializeExtensionMenu() {
    try {
        let html;

        try {
            html = await $.get(`${extensionFolderUrl}settings.html`);
        } catch (folderError) {
            html = await $.get(`/scripts/extensions/third-party/${extensionName}/settings.html`);
        }

        $("#extensions_settings").append(html);

        updateExtensionMenuUI();

        setupExtensionMenuEventHandlers();

        console.log(`${LOG_PREFIX} 확장 메뉴 초기화 완료`);
    } catch (error) {
        console.error(`${LOG_PREFIX} 확장 메뉴 초기화 실패:`, error);
    }
}

function getSavedPrompt(scope) {
    return normalizeDirectionPromptObject(getSettings().directionPrompt)[scope] ?? "";
}

function refreshPromptEditorState() {
    SCOPE_ORDER.forEach((scope) => {
        $(`.dm-prompt-tab-btn[data-scope="${scope}"]`).toggleClass("dm-prompt-tab-btn--dirty", promptDrafts[scope] !== undefined);
    });

    const dirty = promptDrafts[promptEditorScope] !== undefined;
    $("#direction_prompt_save").toggleClass("dm-prompt-save--dirty", dirty).prop("disabled", !dirty);
    $("#direction_prompt_revert").prop("disabled", !dirty);
}

function updateExtensionMenuUI() {
    const settings = getSettings();

    $("#direction_manager_enabled").prop("checked", settings.extensionEnabled);

    $(".dm-prompt-tab-btn")
        .removeClass("dm-prompt-tab-btn--active")
        .filter(`[data-scope="${promptEditorScope}"]`)
        .addClass("dm-prompt-tab-btn--active");

    const draft = promptDrafts[promptEditorScope];
    $("#direction_prompt_text").val(draft !== undefined ? draft : getSavedPrompt(promptEditorScope));

    SCOPE_ORDER.forEach((scope) => {
        $(`#direction_prompt_depth_${scope}`).val(settings.promptDepth?.[scope] ?? DEFAULT_PROMPT_DEPTHS[scope]);
    });

    refreshPromptEditorState();
}

async function clearCurrentCharScopeData() {
    const key = getCurrentCharKey();

    if (!key) {
        toastr.warning("현재 캐릭터를 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("캐릭터 데이터 삭제", "이 채팅방의 캐릭터 칸 저장 내용을 삭제하시겠습니까? (프리셋은 지워지지 않아요)");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();
    delete settings.chars[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

async function clearAllScopeData() {
    const first = await showNativeConfirm("모든 채팅방 데이터 삭제", "모든 채팅방의 전역·캐릭터·줄거리·채팅 칸 내용을 전부 삭제합니다. 프리셋과 프롬프트·Depth 설정은 그대로예요. 되돌릴 수 없어요. 계속할까요?");

    if (!first) {
        return;
    }

    const second = await showNativeConfirm("정말 삭제할까요?", "마지막 확인이에요. 모든 채팅방에 저장된 칸 내용이 사라집니다.", { okButton: "전부 삭제", cancelButton: "취소" });

    if (!second) {
        return;
    }

    const settings = getSettings();
    const enabled = Boolean(settings.global?.direction?.enabled);

    settings.global = sanitizeScopeState({ direction: { enabled, entries: [""], activeIndex: 0 } });
    settings.globals = {};
    settings.chars = {};
    settings.chats = {};
    Object.values(PLOT_STORE).forEach((storeKey) => {
        settings[storeKey] = {};
    });

    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
    toastr.success("모든 채팅방의 저장 내용을 삭제했어요.");
}

async function clearCurrentGlobalScopeData() {
    const key = getCurrentChatKey();

    if (!key) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("전역 데이터 삭제", "이 채팅방의 전역 칸을 처음 상태(기본 프리셋)로 되돌리시겠습니까? (프리셋은 지워지지 않아요)");

    if (!confirmed) {
        return;
    }

    delete getSettings().globals[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

async function clearCurrentChatScopeData() {
    const key = getCurrentChatKey();

    if (!key) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("채팅 데이터 삭제", "이 채팅방의 채팅 칸 저장 내용을 삭제하시겠습니까?");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();
    delete settings.chats[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

async function clearCurrentPlotScopeData() {
    const key = getCurrentChatKey();

    if (!key) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("줄거리 데이터 삭제", "현재 채팅의 줄거리(큰 줄거리·작은 줄거리) 저장 내용을 삭제하시겠습니까?");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();

    Object.values(PLOT_STORE).forEach((storeKey) => {
        if (settings[storeKey]) {
            delete settings[storeKey][key];
        }
    });

    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

function setupExtensionMenuEventHandlers() {
    $("#direction_manager_enabled").on("change", function () {
        const isEnabled = $(this).is(":checked");
        getSettings().extensionEnabled = isEnabled;

        if (isEnabled) {
            if (compactUIButton) {
                compactUIButton.show();
            }

            applyAllPlaceholders();
        } else {
            if (compactUIButton) {
                compactUIButton.hide();

                if (compactUIPopup) {
                    closeCompactUIPopup();
                }
            }

            removeAllPlaceholders();
        }

        saveSettingsDebounced();
    });

    $(".dm-prompt-tab-btn").on("click", function () {
        promptEditorScope = String($(this).data("scope"));
        updateExtensionMenuUI();
    });

    // 프롬프트는 저장 버튼을 눌러야 반영된다. 고치는 중에는 초안으로만 들고 있고, 저장 버튼에 불이 켜진다.
    $("#direction_prompt_text").on("input", function () {
        const value = String($(this).val() ?? "");

        if (value === getSavedPrompt(promptEditorScope)) {
            delete promptDrafts[promptEditorScope];
        } else {
            promptDrafts[promptEditorScope] = value;
        }

        refreshPromptEditorState();
    });

    $("#direction_prompt_save").on("click", function () {
        const draft = promptDrafts[promptEditorScope];

        if (draft === undefined) return;

        const settings = getSettings();
        settings.directionPrompt = normalizeDirectionPromptObject(settings.directionPrompt);
        settings.directionPrompt[promptEditorScope] = draft;
        delete promptDrafts[promptEditorScope];
        saveSettingsDebounced();
        refreshPromptEditorState();
        toastr.success("프롬프트를 저장했어요.");
    });

    $("#direction_prompt_revert").on("click", function () {
        delete promptDrafts[promptEditorScope];
        updateExtensionMenuUI();
    });

    const bindScopeDepthInput = (scope, elementId) => {
        $(elementId).on("input", function () {
            const value = parseInt(String($(this).val()), 10);
            const settings = getSettings();
            settings.promptDepth = normalizePromptDepth(settings.promptDepth);
            settings.promptDepth[scope] = Number.isNaN(value) ? DEFAULT_PROMPT_DEPTHS[scope] : value;
            saveSettingsDebounced();
        });
    };

    SCOPE_ORDER.forEach((scope) => {
        bindScopeDepthInput(scope, `#direction_prompt_depth_${scope}`);
    });

    $("#direction_reset_prompt").on("click", async function () {
        const confirmed = await showNativeConfirm("기본값으로 초기화", "모든 범위의 프롬프트와 삽입 위치(Depth)를 기본값으로 되돌립니다. 저장해 둔 내용(프리셋, 각 채팅방 내용)은 그대로예요. 계속할까요?");

        if (!confirmed) return;

        const settings = getSettings();
        settings.directionPrompt = { ...DEFAULT_DIRECTION_PROMPTS };
        settings.promptDepth = { ...DEFAULT_PROMPT_DEPTHS };
        promptDrafts = {};
        updateExtensionMenuUI();
        saveSettingsDebounced();
    });

    $("#direction_clear_global").on("click", clearCurrentGlobalScopeData);
    $("#direction_clear_all").on("click", clearAllScopeData);
    $("#direction_clear_char").on("click", clearCurrentCharScopeData);
    $("#direction_clear_chat").on("click", clearCurrentChatScopeData);
    $("#direction_clear_plot").on("click", clearCurrentPlotScopeData);
}

function handleContextChanged() {
    applyAllPlaceholders();
    refreshPopupIfOpened();
}

function injectDirectionPrompt(eventData) {
    const settings = getSettings();

    if (!settings.extensionEnabled) {
        return;
    }

    const messages = eventData.chat || eventData.messages;

    if (!messages || !Array.isArray(messages)) {
        return;
    }

    const templates = normalizeDirectionPromptObject(settings.directionPrompt);
    const injections = [];

    SCOPE_ORDER.forEach((scope) => {
        const value = getScopedPlaceholder(scope, "direction");

        if (!isValidEnabledContent(value)) {
            return;
        }

        const template = templates[scope];

        if (!template || template.trim() === "") {
            return;
        }

        const processedPrompt = template
            .replace(/\{\{direction\}\}/g, () => value.content.trim())
            .replace(/\{\{char\}\}/g, "")
            .replace(/\{\{user\}\}/g, "");

        injections.push({
            depth: getScopeDepth(scope),
            message: { role: "system", content: processedPrompt },
        });
    });

    if (injections.length === 0) {
        return;
    }

    // 모든 Depth를 "원래 메시지 기준"으로 정확히 맞추기 위해, 깊은 것(앞쪽)부터 삽입한다.
    // (이미 끼워 넣은 개수만큼 인덱스가 밀리는 것을 보정) 같은 Depth끼리는 SCOPE_ORDER 순서를 유지한다.
    const originalLength = messages.length;
    let inserted = 0;

    injections
        .sort((a, b) => b.depth - a.depth)
        .forEach(({ depth, message }) => {
            const index = Math.max(originalLength - depth, 0) + inserted;
            messages.splice(index, 0, message);
            inserted += 1;
        });
}

jQuery(async () => {
    await loadSettings();
    applyAllPlaceholders();

    await initializeExtensionMenu();

    addCompactUIButton();

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, injectDirectionPrompt);
    eventSource.on(event_types.CHAT_CHANGED, handleContextChanged);

    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, handleContextChanged);
    }
});
