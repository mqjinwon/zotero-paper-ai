pref("extensions.zotero.paperai.provider", "grok");
pref("extensions.zotero.paperai.model", "grok-4.5");
pref("extensions.zotero.paperai.grokApiKey", "");
pref("extensions.zotero.paperai.grokBaseUrl", "https://api.x.ai/v1");
pref("extensions.zotero.paperai.grokAuthPath", "");
pref("extensions.zotero.paperai.codexAuthPath", "");
/* Empty = {Zotero data directory}/paperai; override absolute or ~/path */
pref("extensions.zotero.paperai.dataDir", "");
pref("extensions.zotero.paperai.targetLang", "ko");
pref("extensions.zotero.paperai.autoTranslateOnSelect", true);
pref("extensions.zotero.paperai.autoTranslateMinChars", 8);
// Last user-resized translate result box size (px)
pref("extensions.zotero.paperai.translateResultW", 320);
pref("extensions.zotero.paperai.translateResultH", 120);
// Grok reasoning: none | low | medium | high
// grok-4.5 rejects "none" → client coerces to "low"
pref("extensions.zotero.paperai.reasoningEffort", "medium");

// Per-feature: empty provider/model/baseUrl/reasoning → use global above
// Translate
pref("extensions.zotero.paperai.translateProvider", "");
pref("extensions.zotero.paperai.translateModel", "grok-4.5");
pref("extensions.zotero.paperai.translateBaseUrl", "");
pref("extensions.zotero.paperai.translateReasoning", "low");

// Explain selection
pref("extensions.zotero.paperai.explainProvider", "");
pref("extensions.zotero.paperai.explainModel", "grok-4.5");
pref("extensions.zotero.paperai.explainBaseUrl", "");
pref("extensions.zotero.paperai.explainReasoning", "");

// Chat / free-form Q&A
pref("extensions.zotero.paperai.chatProvider", "");
pref("extensions.zotero.paperai.chatModel", "grok-4.5");
pref("extensions.zotero.paperai.chatBaseUrl", "");
pref("extensions.zotero.paperai.chatReasoning", "");

// Figure vision
pref("extensions.zotero.paperai.figureProvider", "");
pref("extensions.zotero.paperai.figureModel", "grok-4.5");
pref("extensions.zotero.paperai.figureBaseUrl", "");
pref("extensions.zotero.paperai.figureReasoning", "");

// RAG (full-paper Q&A / figure). Default: BM25, zero embed key.
pref("extensions.zotero.paperai.ragEnabled", true);
pref("extensions.zotero.paperai.ragRetrievalMode", "auto");
pref("extensions.zotero.paperai.ragTopK", 12);
pref("extensions.zotero.paperai.ragStuffTokenLimit", 14000);
pref("extensions.zotero.paperai.embeddingProvider", "none");
pref("extensions.zotero.paperai.embeddingBaseUrl", "");
pref("extensions.zotero.paperai.embeddingApiKey", "");
pref("extensions.zotero.paperai.embeddingModel", "text-embedding-3-small");

// Auto-highlight (claim / method / novelty / caveat)
pref("extensions.zotero.paperai.autoHlMaxTotal", 16);
pref("extensions.zotero.paperai.autoHlMaxPerCategory", 4);
pref("extensions.zotero.paperai.autoHlClaimColor", "#ffd400");
pref("extensions.zotero.paperai.autoHlClaimType", "highlight");
pref("extensions.zotero.paperai.autoHlMethodColor", "#2ea8e5");
pref("extensions.zotero.paperai.autoHlMethodType", "underline");
pref("extensions.zotero.paperai.autoHlNoveltyColor", "#5fb236");
pref("extensions.zotero.paperai.autoHlNoveltyType", "highlight");
pref("extensions.zotero.paperai.autoHlCaveatColor", "#ff6666");
pref("extensions.zotero.paperai.autoHlCaveatType", "underline");
