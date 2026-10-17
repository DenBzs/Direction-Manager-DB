import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";
import { Popup } from "../../../popup.js";

const extensionName = "Direction-Manager-DB";
const LOG_PREFIX = "[🪄전개지시M]";
const extensionFolderUrl = new URL(".", import.meta.url).pathname;

const DEFAULT_DIRECTION_PROMPT_CHAT = `<direction>
- This is the director's instruction for the next reply. Follow it with the highest priority.
- Accept any form of instruction—whether it is continuing the story, answering questions, handling OOC requests, applying specific conditions, or setting tone and style. Do exactly as requested without forcing unnecessary story narration.
- Story drafts: keep dialogue's intent, tone, and key wording, using it as is if it already reads well. Rewrite non-dialogue draft text into natural prose and fill in missing causality.

[Direction(If blank, develop the story as you see fit): {{direction}}]
</direction>`;

const DEFAULT_DIRECTION_PROMPT_GLOBAL = `<format_rules>
- These are standing rules for every reply in this roleplay. Follow them exactly, without exception.

{{direction}}
</format_rules>`;

const DEFAULT_DIRECTION_PROMPT_CHAR = `<character_notes>
- Background knowledge only. Keep in mind while writing.
- Never state, quote, or explain these notes directly. Let them surface indirectly through tone, behavior, and small details only when relevant.

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

const DEFAULT_DIRECTION_PROMPT_AU = `<world_setting>
- The following are established facts and rules of this world. Apply them consistently to how characters think, behave, and interact.
- Show these rules naturally through narration, behavior, and environment rather than lecturing or explaining them directly.
- If a rule conflicts with a character's core personality, keep the character true to themselves while expressing the rule in a subtle, adapted way.

{{direction}}
</world_setting>`;

const LEGACY_CHAR_PROMPT_V5 = `<character_notes>
- The following are ongoing notes about the current situation, emotions, personality, or world details that apply to this conversation for the next several turns.
- Treat them as established fact and weave them naturally into the story; do not quote them directly or announce that you received notes.

{{direction}}
</character_notes>`;

const LEGACY_PROMPTS_V9 = {
    global: `<format_rules>
- These are standing formatting/style rules for every reply in this roleplay. Follow them exactly, without exception, for as long as they are enabled below.
- Do not quote or restate these rules in your reply; just apply them silently.

{{direction}}
</format_rules>`,
    au: `<world_setting>
- The following describes the alternate-universe (AU) rules and worldbuilding of this roleplay (special dynamics, hierarchies, biology, social structure, and so on). Treat them as established facts of this world for as long as they are enabled.
- Several AU settings may be given at once. Treat them as one combined world and keep them consistent with each other.
- Apply them consistently to how characters think, behave, and relate to one another, and to how the world responds to them.
- Never quote, list, or explain these rules in your reply. Let them show only through natural narration, behavior, and small details, as if the world has always worked this way.
- If a rule seems to conflict with a character's established personality, keep the character true to themselves and adapt how the rule is expressed.

{{direction}}
</world_setting>`,
    char: `<character_notes>
- The following are background notes about the characters' current state and the world (situation, emotions, personality, setting).
- Keep them in mind as quiet background knowledge while writing. They do not need to show up in every reply.
- Never state, quote, or explain these notes directly. Let them surface only indirectly, through tone, behavior, and small details, and only when it fits the scene.

{{direction}}
</character_notes>`,
    chat: `<direction>
- Resume the story based on the director's instructions below.
- The director only provides drafts; refine them into natural prose instead of directly quoting the sentences.
- Creatively construct and fill in any parts lacking persuasive causality so that the narrative suggested by the director unfolds smoothly.

[Direction(If blank, develop the story as you see fit): {{direction}}]
</direction>`,
};

const DEFAULT_DIRECTION_PROMPT = DEFAULT_DIRECTION_PROMPT_CHAT;

const DEFAULT_DIRECTION_PROMPTS = {
    global: DEFAULT_DIRECTION_PROMPT_GLOBAL,
    au: DEFAULT_DIRECTION_PROMPT_AU,
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
    au: "[World Setting]",
    char: "[Character Notes]",
    plotMain: "[Story Direction]",
    plotNext: "[Next Beats]",
    chat: "[Director's Note]",
};

const SCOPE_ORDER = ["global", "au", "char", "plotMain", "plotNext", "chat"];

const TAB_ORDER = ["global", "au", "char", "plot", "chat"];
const TAB_SCOPES = {
    global: ["global"],
    au: ["au"],
    char: ["char"],
    plot: ["plotMain", "plotNext"],
    chat: ["chat"],
};

// 숫자가 작을수록 최신 메시지에 가깝다 (0 = 맨 끝)
const DEFAULT_PROMPT_DEPTHS = { global: 0, au: 2, char: 2, plotMain: 4, plotNext: 3, chat: 1 };
const LEGACY_PROMPT_DEPTHS_V7 = { global: 2, char: 5, plotMain: 3, plotNext: 1, chat: 0 };

const SHARED_SCOPES = {
    global: { shared: "global", store: "globals" },
    au: { shared: "au", store: "aus" },
};

function isPresetScope(scope) {
    return Boolean(SHARED_SCOPES[scope]);
}

const PLOT_STORE = { plotMain: "plotMains", plotNext: "plotNexts" };

const SCOPE_PLACEHOLDERS = {
    default: "Direction 내용을 입력하세요...",
    au: "AU 설정을 적으세요 (예: 오메가버스의 규칙과 설정)",
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

function scopeHidesPresets(scope) {
    return !isPresetScope(scope);
}

function usesFreeSize(scope) {
    return scope === "chat" || scope === "char";
}

const HISTORY_TOTAL_MAX = 5;
const HISTORY_MIN_CHARS = 1;
const HISTORY_MAX = HISTORY_TOTAL_MAX - 1;

function defaultScopeState() {
    return {
        direction: defaultPlaceholderState(),
    };
}

const defaultSettings = {
    global: defaultScopeState(),
    au: defaultScopeState(),
    aus: {},
    chars: {},
    chats: {},
    plotMains: {},
    plotNexts: {},
    globals: {},
    presetPins: { global: [], au: [] },
    presets: {
        direction: { global: [], au: [], char: [], plotMain: [], plotNext: [], chat: [] },
    },
    extensionEnabled: true,
    directionPrompt: { ...DEFAULT_DIRECTION_PROMPTS },
    promptDepth: { ...DEFAULT_PROMPT_DEPTHS },
    lastScope: "chat",
    _migratedV2: false,
    _migratedV3: false,
    _migratedV4: false,
    _migratedV5: false,
    _migratedV6: false,
    _migratedV7: false,
    _migratedV8: false,
    _migratedV9: false,
    _migratedV10: false,
    _migratedV11: false,
};

let currentScope = "chat";
function textareaHeightGroup(scope) {
    if (usesFreeSize(scope)) return "chat";
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

const PLOT_CHROME_PX = 45;
const PLOT_MAIN_HEIGHT_RATIO = 0.4;

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

    if (usesFreeSize(currentScope) && !chatHeightIsCustom) {
        textarea[0].style.height = `${Math.round(sharedPx + cachedPresetRowHeight)}px`;
        return;
    }

    const group = textareaHeightGroup(currentScope);
    textarea[0].style.height = compactUITextareaHeights[group] || defaultTextareaHeightPx();
}

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

function beginHistorySession(scopedValue) {
    const lastIndex = scopedValue.entries.length - 1;
    sessionSnapshot = scopedValue.activeIndex === lastIndex ? scopedValue.entries[lastIndex] : null;
}

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
let isNativePopupOpen = false;
let compactUIApplyDebounceTimer = null;
let promptEditorScope = "global";
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
    const state = {
        direction: sanitizePlaceholderValue(source.direction),
        presetId: typeof source.presetId === "string" ? source.presetId : "",
    };

    if (Array.isArray(source.onIds)) {
        state.onIds = source.onIds.filter((id) => typeof id === "string");
    }

    return state;
}

function toIdArray(value) {
    if (Array.isArray(value)) return value.filter((id) => typeof id === "string" && id);
    return typeof value === "string" && value ? [value] : [];
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
        au: sanitizePresetList(src.au),
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
    if (isPresetScope(scope)) {
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
    settings.au = sanitizeScopeState(settings.au);
    settings.aus = settings.aus && typeof settings.aus === "object" ? settings.aus : {};
    settings.chars = settings.chars && typeof settings.chars === "object" ? settings.chars : {};
    settings.chats = settings.chats && typeof settings.chats === "object" ? settings.chats : {};
    Object.values(PLOT_STORE).forEach((storeKey) => {
        settings[storeKey] = settings[storeKey] && typeof settings[storeKey] === "object" ? settings[storeKey] : {};
    });
    settings.presets = sanitizePresets(settings.presets);
    settings.globals = settings.globals && typeof settings.globals === "object" ? settings.globals : {};
    const pins = settings.presetPins && typeof settings.presetPins === "object" ? settings.presetPins : {};
    settings.presetPins = {
        global: toIdArray(pins.global),
        au: toIdArray(pins.au),
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
    settings._migratedV9 = Boolean(settings._migratedV9);
    settings._migratedV10 = Boolean(settings._migratedV10);
    settings._migratedV11 = Boolean(settings._migratedV11);

    Object.keys(settings.aus).forEach((key) => {
        settings.aus[key] = sanitizeScopeState(settings.aus[key]);
    });

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

    settings.presetPins.global = [pinned.id];
    settings._migratedV7 = true;
    console.log(`${LOG_PREFIX} 전역 "기본" 프리셋을 만들고 고정했습니다.`);
    return true;
}

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

function migrateV9AuScopeIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV9) {
        return false;
    }

    const lists = settings.presets.direction;

    if (lists.char.length > 0 && lists.au.length === 0) {
        lists.au = lists.char;
        lists.char = [];
        console.log(`${LOG_PREFIX} 캐릭터 프리셋 ${lists.au.length}개를 AU 프리셋으로 옮겼습니다.`);
    }

    Object.keys(settings.globals).forEach((key) => {
        const entry = settings.globals[key];

        if (Array.isArray(entry.onIds)) return;

        const selectedId = resolveSelectedId("global", entry);
        entry.onIds = selectedId ? [selectedId] : [];
    });

    settings._migratedV9 = true;
    return true;
}

function migrateV10ShortPromptsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV10) {
        return false;
    }

    const prompts = settings.directionPrompt;

    if (prompts && typeof prompts === "object") {
        Object.keys(LEGACY_PROMPTS_V9).forEach((scope) => {
            if (prompts[scope] === LEGACY_PROMPTS_V9[scope]) {
                prompts[scope] = DEFAULT_DIRECTION_PROMPTS[scope];
            }
        });
    }

    settings._migratedV10 = true;
    console.log(`${LOG_PREFIX} 기본 프롬프트를 짧은 버전으로 교체했습니다. (직접 고친 프롬프트는 그대로)`);
    return true;
}

function migrateV11MergeCharPresetsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV11) {
        return false;
    }

    const lists = settings.presets.direction;
    const leftover = lists.char;

    if (leftover.length > 0) {
        settings.presetBackupV11 = { char: cloneSettings(leftover) };

        const seen = new Set(lists.au.map((preset) => `${preset.name}\n${preset.content}`));
        const usedIds = new Set(lists.au.map((preset) => preset.id));
        let moved = 0;

        leftover.forEach((preset) => {
            const signature = `${preset.name}\n${preset.content}`;

            if (seen.has(signature)) return;

            seen.add(signature);
            lists.au.push({ ...preset, id: usedIds.has(preset.id) ? generatePresetId() : preset.id });
            moved += 1;
        });

        lists.char = [];
        console.log(`${LOG_PREFIX} 캐릭터 프리셋 ${leftover.length}개 중 ${moved}개를 AU 프리셋에 합쳤습니다. (원본은 presetBackupV11에 보관)`);
    }

    settings._migratedV11 = true;
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
    const migratedV9 = migrateV9AuScopeIfNeeded();
    const migratedV10 = migrateV10ShortPromptsIfNeeded();
    const migratedV11 = migrateV11MergeCharPresetsIfNeeded();

    if (migrated || migratedV3 || migratedV4 || migratedV5 || migratedV6 || migratedV7 || migratedV8 || migratedV9 || migratedV10 || migratedV11 || pruned) {
        saveSettingsDebounced();
    }
}

function getSharedScoped(scope) {
    const settings = getSettings();
    const { shared: sharedKey, store: storeKey } = SHARED_SCOPES[scope];
    const shared = sanitizeScopeState(settings[sharedKey]);
    const key = getCurrentChatKey();

    if (!key) {
        return shared;
    }

    const entry = settings[storeKey]?.[key];
    let direction;
    let presetId = "";
    let onIds;

    if (entry) {
        direction = sanitizePlaceholderValue(entry.direction);
        presetId = typeof entry.presetId === "string" ? entry.presetId : "";
        onIds = Array.isArray(entry.onIds) ? entry.onIds : undefined;
    } else {
        const pinned = getFirstPinnedPreset(scope);

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
        onIds,
    });
}

function ensureSharedScoped(scope) {
    const settings = getSettings();
    const { shared: sharedKey, store: storeKey } = SHARED_SCOPES[scope];
    settings[sharedKey] = sanitizeScopeState(settings[sharedKey]);
    const key = getCurrentChatKey();

    if (!key) {
        return settings[sharedKey];
    }

    settings[storeKey] = settings[storeKey] && typeof settings[storeKey] === "object" ? settings[storeKey] : {};

    if (!settings[storeKey][key]) {
        const current = getSharedScoped(scope);
        settings[storeKey][key] = sanitizeScopeState({
            direction: current.direction,
            presetId: current.presetId,
            onIds: getEffectiveOnIds(scope, current),
        });
    }

    const entry = sanitizeScopeState(settings[storeKey][key]);
    settings[storeKey][key] = entry;

    return {
        get direction() {
            return { ...entry.direction, enabled: settings[sharedKey].direction.enabled };
        },
        set direction(value) {
            const next = sanitizePlaceholderValue(value);
            settings[sharedKey].direction = sanitizePlaceholderValue({ ...settings[sharedKey].direction, enabled: next.enabled });
            entry.direction = { ...next };
        },
        get presetId() {
            return entry.presetId;
        },
        set presetId(value) {
            entry.presetId = typeof value === "string" ? value : "";
        },
        get onIds() {
            return entry.onIds;
        },
        set onIds(value) {
            entry.onIds = toIdArray(value);
        },
    };
}

function ensureScopedSettings(scope) {
    const settings = getSettings();

    if (isPresetScope(scope)) {
        return ensureSharedScoped(scope);
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

    if (isPresetScope(scope)) {
        return getSharedScoped(scope);
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

function getInjectionPlaceholder(scope, placeholderKey) {
    const value = getScopedPlaceholder(scope, placeholderKey);

    if (!value || !isPresetScope(scope)) return value;

    return { ...value, content: composePresetContent(scope) };
}

function resolveCombinedContent(placeholderKey) {
    const parts = [];
    const activeScopes = [];

    SCOPE_ORDER.forEach((scope) => {
        const value = getInjectionPlaceholder(scope, placeholderKey);

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

function getPinnedIds(scope) {
    return toIdArray(getSettings().presetPins?.[scope]);
}

function getFirstPinnedPreset(scope) {
    const ids = getPinnedIds(scope);
    if (!ids.length) return null;
    return getPresetList("direction", scope).find((preset) => ids.includes(preset.id)) || null;
}

function resolveSelectedId(scope, scoped) {
    const list = getPresetList("direction", scope);
    const storedId = scoped?.presetId || "";

    if (storedId && list.some((preset) => preset.id === storedId)) {
        return storedId;
    }

    const pinned = getFirstPinnedPreset(scope);
    if (pinned) return pinned.id;

    const content = scoped ? sanitizePlaceholderValue(scoped.direction).content : "";

    if (content) {
        const matched = list.find((preset) => preset.content === content);
        if (matched) return matched.id;
    }

    return "";
}

function getSelectedPresetId(scope) {
    return resolveSelectedId(scope, getScopedSettings(scope));
}

function getEffectiveOnIds(scope, scoped) {
    const ids = Array.isArray(scoped?.onIds) ? scoped.onIds : getPinnedIds(scope);
    const set = new Set(ids);
    return getPresetList("direction", scope).filter((preset) => set.has(preset.id)).map((preset) => preset.id);
}

function setSelectedPresetId(scope, presetId) {
    const scoped = ensureScopedSettings(scope);
    if (scoped) scoped.presetId = presetId;
}

function setPresetOn(scope, presetId, on) {
    const scoped = ensureScopedSettings(scope);
    if (!scoped) return false;

    const next = new Set(getEffectiveOnIds(scope, getScopedSettings(scope)));

    if (on) next.add(presetId);
    else next.delete(presetId);

    scoped.onIds = getPresetList("direction", scope).filter((preset) => next.has(preset.id)).map((preset) => preset.id);
    return true;
}

function composePresetContent(scope) {
    const scoped = getScopedSettings(scope);
    if (!scoped) return "";

    const draft = typeof scoped.direction.content === "string" ? scoped.direction.content : "";
    const currentId = resolveSelectedId(scope, scoped);
    const onIds = new Set(getEffectiveOnIds(scope, scoped));
    const parts = [];

    getPresetList("direction", scope).forEach((preset) => {
        if (!onIds.has(preset.id)) return;

        const text = preset.id === currentId ? draft : preset.content;
        if (typeof text === "string" && text.trim()) parts.push(text.trim());
    });

    if (!currentId && draft.trim()) parts.push(draft.trim());

    return parts.join("\n\n");
}

function presetStoreOf(scope) {
    return SHARED_SCOPES[scope]?.store || "";
}

function propagatePresetContent(scope, presetId, oldContent, newContent) {
    const store = getSettings()[presetStoreOf(scope)];

    Object.values(store || {}).forEach((entry) => {
        if (!entry || entry.presetId !== presetId) return;

        const direction = sanitizePlaceholderValue(entry.direction);
        if (direction.content !== oldContent) return;

        const entries = direction.entries.slice();
        entries[direction.activeIndex] = newContent;
        entry.direction = sanitizePlaceholderValue({ ...direction, entries });
    });
}

function purgeDeletedPreset(scope, presetId, deletedContent) {
    const settings = getSettings();
    const storeKey = presetStoreOf(scope);
    const store = settings[storeKey];
    const sharedKey = SHARED_SCOPES[scope]?.shared;
    const hasContent = typeof deletedContent === "string" && deletedContent.trim() !== "";

    // ★에서 먼저 빼야 되돌아갈 프리셋에 지운 프리셋이 끼지 않는다
    if (settings.presetPins) {
        settings.presetPins[scope] = getPinnedIds(scope).filter((id) => id !== presetId);
    }

    const fallback = getFirstPinnedPreset(scope);
    const fallbackId = fallback ? fallback.id : "";
    const fallbackContent = fallback ? fallback.content : "";
    const freshDirection = () => sanitizePlaceholderValue({ entries: [fallbackContent], activeIndex: 0 });

    Object.values(store || {}).forEach((entry) => {
        if (!entry) return;

        const content = typeof entry.direction?.content === "string" ? entry.direction.content : "";
        const wasOpen = entry.presetId === presetId || (!entry.presetId && hasContent && content === deletedContent);

        if (wasOpen) {
            entry.presetId = fallbackId;
            entry.direction = freshDirection();
        }

        if (Array.isArray(entry.onIds)) entry.onIds = entry.onIds.filter((id) => id !== presetId);
    });

    const shared = sharedKey ? settings[sharedKey] : null;
    const sharedContent = typeof shared?.direction?.content === "string" ? shared.direction.content : "";

    if (shared && hasContent && sharedContent === deletedContent) {
        shared.direction = { ...freshDirection(), enabled: Boolean(shared.direction.enabled) };
    }
}

function refreshPresetControls() {
    if (!compactUIPopup || scopeHidesPresets(currentScope)) return;

    const placeholder = getPopupCurrentPlaceholder();
    const selectedId = getSelectedPresetId(currentScope);
    const preset = selectedId ? getPresetList(placeholder.key, currentScope).find((item) => item.id === selectedId) : null;
    const dirty = Boolean(preset) && getCurrentScopeState(placeholder.key).content !== preset.content;

    compactUIPopup.find(".dm-compact--preset-save").toggleClass("dm-compact--preset-dirty", dirty);
    compactUIPopup.find(".dm-compact--preset-rename, .dm-compact--preset-delete").prop("disabled", !preset);
}

let presetControlsTimer = null;

function schedulePresetControlsRefresh() {
    clearTimeout(presetControlsTimer);
    presetControlsTimer = setTimeout(refreshPresetControls, 150);
}

let presetListOpen = false;
let presetReorderMode = false;

function presetScopeEmptyLabel(scope) {
    return scope === "au" ? "🌐 어떤 AU로 할까?" : "✨️ 어떤 지시를 내릴까?";
}

function buildPresetListHtml() {
    const placeholder = getPopupCurrentPlaceholder();
    const presets = getPresetList(placeholder.key, currentScope);
    const pinnedIds = new Set(getPinnedIds(currentScope));
    const onIds = new Set(getEffectiveOnIds(currentScope, getScopedSettings(currentScope)));
    const selectedId = getSelectedPresetId(currentScope);

    const rows = presets.map((preset, index) => {
        const isSelected = preset.id === selectedId;
        const isPinned = pinnedIds.has(preset.id);
        const isOn = onIds.has(preset.id);
        const move = presetReorderMode
            ? `<span class="dm-compact--move${index === 0 ? " dm-compact--move-off" : ""}" data-act="up">▲</span>`
                + `<span class="dm-compact--move${index === presets.length - 1 ? " dm-compact--move-off" : ""}" data-act="down">▼</span>`
                + `<span class="dm-compact--move dm-compact--move-del" data-act="del" title="프리셋 삭제"><i class="fa-solid fa-trash"></i></span>`
            : "";
        const star = `<span class="dm-compact--star${isPinned ? " dm-compact--star-on" : ""}" data-act="pin" title="새 채팅방에서 처음부터 켜짐">${isPinned ? "★" : "☆"}</span>`;
        const led = `<span class="dm-compact--led-hit" data-act="toggle" title="${isOn ? "끄기" : "켜기"}"><span class="dm-compact--led${isOn ? " dm-compact--led-on" : ""}"></span></span>`;

        return `<div class="dm-compact--preset-item${isSelected ? " dm-compact--preset-item-sel" : ""}" data-id="${preset.id}">`
            + `${led}<span class="dm-compact--preset-item-name">${escapeHtml(preset.name)}</span>${move}${star}</div>`;
    }).join("");

    const head = `<div class="dm-compact--preset-list-head"><span>프리셋 ${presets.length}개 · 켜짐 ${onIds.size}개</span>`
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
    const isPinned = Boolean(preset) && getPinnedIds(currentScope).includes(preset.id);
    const isOn = Boolean(preset) && getEffectiveOnIds(currentScope, getScopedSettings(currentScope)).includes(preset.id);
    const star = isPinned ? '<span class="dm-compact--star dm-compact--star-on">★</span>' : "";
    const led = preset ? `<span class="dm-compact--led dm-compact--led-inline${isOn ? " dm-compact--led-on" : ""}"></span>` : "";

    compactUIPopup.find(".dm-compact--preset-current-name").html(preset ? `${led}${star}${escapeHtml(preset.name)}` : presetScopeEmptyLabel(currentScope));

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

function updateActiveFieldHighlight() {
    if (!compactUIPopup) return;

    compactUIPopup.find(".dm-compact--textarea, .dm-compact--plot-label").each(function () {
        $(this).toggleClass("dm-compact--field-active", $(this).attr("data-scope") === currentScope);
    });
}

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
    compactUIPopup.toggleClass("dm-compact--scope-off", !settings.enabled);

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
        // classList 대신 data 속성 사용: 서드파티 UI 스크립트가 버튼 위치를 초기화하지 않게
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
                <button class="dm-compact--scope-btn" data-tab="global" type="button"><span class="dm-compact--scope-emoji">📜</span>규칙</button>
                <button class="dm-compact--scope-btn" data-tab="au" type="button"><span class="dm-compact--scope-emoji">🌐</span>AU</button>
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

    // touchstart에서 직접 처리해 키보드가 닫히지 않게 하고, 뒤따르는 click은 무시한다
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
        compactUIPopup.toggleClass("dm-compact--scope-off", !isEnabled);

        applyPlaceholderToSystem(currentPlaceholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    compactUIPopup.on("touchstart", ".dm-compact--radio", function (e) {
        e.preventDefault();
        const checkbox = $(this);
        checkbox.prop("checked", !checkbox.prop("checked")).trigger("change");
    });

    compactUIPopup.on("mousedown", ".dm-compact--radio", (e) => {
        e.preventDefault();
    });

    compactUIPopup.on("mousedown touchstart", ".dm-compact--textarea", function (e) {
        if (!usesFreeSize(currentScope) || chatHeightIsCustom) {
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
        getScopeTextarea(currentScope).val(preset.content).trigger("input");
        commitDirectionContentNow(placeholder);
        saveSettingsDebounced();
        setPresetListOpen(false);
        renderPresetSelect();
    }

    compactUIPopup.find(".dm-compact--preset-current").on("click", () => setPresetListOpen(!presetListOpen));

    compactUIPopup.find(".dm-compact--preset-list").on("click", (e) => {
        // 목록을 다시 그리면 눌린 요소가 사라져 바깥 클릭으로 오해받으므로 여기서 이벤트를 끝낸다
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
        } else if (act === "toggle" && index >= 0) {
            const isOn = getEffectiveOnIds(currentScope, getScopedSettings(currentScope)).includes(id);

            if (setPresetOn(currentScope, id, !isOn)) {
                commitDirectionContentNow(placeholder);
                saveSettingsDebounced();
                renderPresetSelect();
            }
        } else if (act === "pin" && index >= 0) {
            const pins = getPinnedIds(currentScope);
            settings.presetPins[currentScope] = pins.includes(id) ? pins.filter((pinId) => pinId !== id) : [...pins, id];
            saveSettingsDebounced();
            renderPresetSelect();
        } else if (act === "del" && index >= 0) {
            deletePresetById(id);
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
        setPresetOn(currentScope, preset.id, true);
        commitDirectionContentNow(placeholder);
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

    async function deletePresetById(presetId) {
        const placeholder = getPopupCurrentPlaceholder();
        const scope = currentScope;
        const list = getPresetList(placeholder.key, scope);
        const index = list.findIndex((item) => item.id === presetId);

        if (index < 0) return;

        const target = list[index];
        const confirmed = await showNativeConfirm("프리셋 삭제", `"${target.name}" 프리셋을 삭제하시겠습니까? (이 프리셋을 쓰던 모든 채팅방에서도 이 프리셋의 내용이 함께 사라져요)`);

        if (!confirmed || !compactUIPopup || scope !== currentScope) return;

        const at = list.findIndex((item) => item.id === presetId);
        if (at < 0) return;

        const deletedContent = list[at].content;
        const textarea = getScopeTextarea(scope);
        const before = String(textarea.val() || "");

        list.splice(at, 1);
        purgeDeletedPreset(scope, presetId, deletedContent);

        const state = getCurrentScopeState(placeholder.key);

        if (state.content !== before) {
            textarea.val(state.content);
            sessionSnapshot = null;
            beginHistorySession(state);
        }

        commitDirectionContentNow(placeholder);
        saveSettingsDebounced();
        renderPresetSelect();
    }

    compactUIPopup.find(".dm-compact--preset-delete").on("click", () => {
        const selectedId = getSelectedPresetId(currentScope);
        if (selectedId) deletePresetById(selectedId);
    });

    $(document).on("click.compactUI", (e) => {
        if (isNativePopupOpen) {
            return;
        }

        // 다시 그려져 사라진 요소를 누른 경우는 바깥 클릭이 아니다
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
    const first = await showNativeConfirm("모든 채팅방 데이터 삭제", "모든 채팅방의 규칙·AU·캐릭터·줄거리·채팅 칸 내용을 전부 삭제합니다. 프리셋과 프롬프트·Depth 설정은 그대로예요. 되돌릴 수 없어요. 계속할까요?");

    if (!first) {
        return;
    }

    const second = await showNativeConfirm("정말 삭제할까요?", "마지막 확인이에요. 모든 채팅방에 저장된 칸 내용이 사라집니다.", { okButton: "전부 삭제", cancelButton: "취소" });

    if (!second) {
        return;
    }

    const settings = getSettings();
    const enabled = Boolean(settings.global?.direction?.enabled);

    const auEnabled = Boolean(settings.au?.direction?.enabled);

    settings.global = sanitizeScopeState({ direction: { enabled, entries: [""], activeIndex: 0 } });
    settings.globals = {};
    settings.au = sanitizeScopeState({ direction: { enabled: auEnabled, entries: [""], activeIndex: 0 } });
    settings.aus = {};
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

    const confirmed = await showNativeConfirm("규칙 데이터 삭제", "이 채팅방의 규칙 칸을 처음 상태(★ 프리셋만 켜진 상태)로 되돌리시겠습니까? (프리셋은 지워지지 않아요)");

    if (!confirmed) {
        return;
    }

    delete getSettings().globals[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

async function clearCurrentAuScopeData() {
    const key = getCurrentChatKey();

    if (!key) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("AU 데이터 삭제", "이 채팅방의 AU 칸을 처음 상태(★ 프리셋만 켜진 상태)로 되돌리시겠습니까? (프리셋은 지워지지 않아요)");

    if (!confirmed) {
        return;
    }

    delete getSettings().aus[key];
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
    $("#direction_clear_au").on("click", clearCurrentAuScopeData);
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
        const value = getInjectionPlaceholder(scope, "direction");

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

    // 깊은 것(앞쪽)부터 삽입하고, 이미 끼운 개수만큼 인덱스를 보정한다
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
