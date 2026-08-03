/**
 * Tests for shipped paperTask orchestration (single RAG+LLM path).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createNodeFileStore } from "../../src/auth/nodeFileStore.ts";
import { shouldUseRag } from "../../src/rag/config.ts";
import { buildExtractedDoc } from "../../src/rag/extract.ts";
import { paperRefOf } from "../../src/rag/paperRef.ts";
import {
  attachRagContext,
  formatUserVisible,
} from "../../src/ui/paperTask.ts";

const FIXTURE = `
Abstract
Residual force learning for quadrupeds.

1 Introduction
We study locomotion on rough terrain with residual forces.

3 Method
Convex MPC plus residual network corrections.

7 Conclusion
Residual learning helps under model mismatch.
`.trim();

describe("paperTask mode gating", () => {
  it("shouldUseRag for chat/explain/figure, not translate", () => {
    assert.equal(shouldUseRag(true, "chat"), true);
    assert.equal(shouldUseRag(true, "explain"), true);
    assert.equal(shouldUseRag(true, "figure-explain"), true);
    
    assert.equal(shouldUseRag(true, "translate"), false);
    assert.equal(shouldUseRag(false, "chat"), false);
  });

  it("formatUserVisible labels modes", () => {
    assert.match(
      formatUserVisible("translate", { selection: "hello world" }),
      /번역/,
    );
    assert.match(
      formatUserVisible("figure-explain", { hasImage: true, question: "y?" }),
      /그림/,
    );
  });
});

describe("paperTask attachRagContext (shipped)", () => {
  it("chat-like mode attaches contextBlock via queryPaper; translate does not call RAG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperai-task-"));
    try {
      const base = await createNodeFileStore();
      const store = {
        ...base,
        homeDir: () => dir,
        join: (...parts: string[]) => join(...parts),
      };
      const doc = buildExtractedDoc({
        paperId: "t1",
        title: "Fixture",
        fullText: FIXTURE,
      });

      const chat = await attachRagContext({
        mode: "chat",
        store,
        query: "What is residual force learning?",
        extract: doc,
        paper: paperRefOf("t1", { title: "Fixture" }),
        ragPrefs: {
          ragEnabled: true,
          ragRetrievalMode: "bm25",
          embeddingProvider: "none",
          embeddingApiKey: "",
          embeddingBaseUrl: "",
          embeddingModel: "text-embedding-3-small",
          ragTopK: 8,
          ragStuffTokenLimit: 6000,
        },
      });
      assert.equal(chat.usedRag, true);
      assert.ok(chat.contextBlock.length > 0);
      assert.match(chat.contextBlock, /\[§|Evidence|residual/i);

      const tr = await attachRagContext({
        mode: "translate",
        store,
        query: "residual force",
        extract: doc,
        paper: paperRefOf("t1"),
        ragPrefs: {
          ragEnabled: true,
          ragRetrievalMode: "bm25",
          embeddingProvider: "none",
          embeddingApiKey: "",
          embeddingBaseUrl: "",
          embeddingModel: "text-embedding-3-small",
          ragTopK: 8,
          ragStuffTokenLimit: 6000,
        },
      });
      assert.equal(tr.usedRag, false);
      assert.equal(tr.contextBlock, "");
      assert.equal(tr.ragFooter, "");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allowRag:false never retrieves even for chat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperai-task2-"));
    try {
      const base = await createNodeFileStore();
      const store = {
        ...base,
        homeDir: () => dir,
        join: (...parts: string[]) => join(...parts),
      };
      const doc = buildExtractedDoc({
        paperId: "t2",
        fullText: FIXTURE,
      });
      const r = await attachRagContext({
        mode: "chat",
        store,
        query: "summary",
        extract: doc,
        allowRag: false,
        ragPrefs: {
          ragEnabled: true,
          ragRetrievalMode: "auto",
          embeddingProvider: "none",
          embeddingApiKey: "",
          embeddingBaseUrl: "",
          embeddingModel: "x",
          ragTopK: 8,
          ragStuffTokenLimit: 6000,
        },
      });
      assert.equal(r.usedRag, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("paperRef pure helper", () => {
  it("paperRefOf builds stable key", () => {
    const r = paperRefOf("ABCD", { itemID: 12, title: "T" });
    assert.equal(r.itemKey, "ABCD");
    assert.equal(r.itemID, 12);
    assert.equal(r.title, "T");
  });
});
