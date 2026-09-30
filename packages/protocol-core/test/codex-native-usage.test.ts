import { describe, expect, it } from "vitest";

import type { HostTurnId } from "@codexhost/shared-contracts";
import {
  CodexOutputSpeedTracker,
  type CodexOutputSpeedSample,
  observeCodexRateLimitResetCredits,
  observeCodexRateLimits,
  observeCodexTokenUsage,
  projectCodexRateLimitsToCredits,
} from "../src/codex-native-usage.js";

describe("native Codex output speed", () => {
  const sample = (
    turnId: string,
    outputTokens: number,
    atMs: number,
    threadId = "thread-a",
  ): CodexOutputSpeedSample => ({
    threadId,
    turnId: turnId as HostTurnId,
    outputTokens,
    atMs,
  });

  it("needs two observations of the same Turn before it can measure anything", () => {
    const tracker = new CodexOutputSpeedTracker();
    tracker.observe(sample("turn-1", 100, 1000));
    expect(tracker.speedFor("thread-a")).toBeUndefined();
  });

  it("measures decode speed between the first and last observation of a Turn", () => {
    const tracker = new CodexOutputSpeedTracker();
    tracker.observe(sample("turn-1", 100, 1000));
    tracker.observe(sample("turn-1", 160, 3000));
    expect(tracker.speedFor("thread-a")).toBe(30);
  });

  it("excludes the time before the first observation, which is time-to-first-token", () => {
    const tracker = new CodexOutputSpeedTracker();
    tracker.observe(sample("turn-1", 10, 1000));
    tracker.observe(sample("turn-1", 60, 2000));
    expect(tracker.speedFor("thread-a")).toBe(50);
  });

  it("never measures across a Turn boundary", () => {
    const tracker = new CodexOutputSpeedTracker();
    tracker.observe(sample("turn-1", 100, 1000));
    tracker.observe(sample("turn-2", 500, 2000));
    tracker.observe(sample("turn-2", 560, 3000));
    // 60 tokens over 1000ms from the turn-2 window, not 460 over 2000ms.
    expect(tracker.speedFor("thread-a")).toBe(60);
  });

  it("ignores an observation that moved no tokens", () => {
    const tracker = new CodexOutputSpeedTracker();
    tracker.observe(sample("turn-1", 100, 1000));
    tracker.observe(sample("turn-1", 100, 5000));
    expect(tracker.speedFor("thread-a")).toBeUndefined();
  });

  it("ignores an observation whose clock did not move", () => {
    const tracker = new CodexOutputSpeedTracker();
    tracker.observe(sample("turn-1", 100, 1000));
    tracker.observe(sample("turn-1", 150, 1000));
    expect(tracker.speedFor("thread-a")).toBeUndefined();
  });

  it("keeps Threads independent", () => {
    const tracker = new CodexOutputSpeedTracker();
    tracker.observe(sample("turn-1", 100, 1000, "thread-a"));
    tracker.observe(sample("turn-1", 100, 1000, "thread-b"));
    tracker.observe(sample("turn-1", 120, 1100, "thread-a"));
    tracker.observe(sample("turn-1", 180, 1200, "thread-b"));
    expect(tracker.speedFor("thread-a")).toBe(200);
    expect(tracker.speedFor("thread-b")).toBe(400);
  });

  it("drops every window and every measurement on reset", () => {
    const tracker = new CodexOutputSpeedTracker();
    tracker.observe(sample("turn-1", 100, 1000));
    tracker.observe(sample("turn-1", 200, 2000));
    expect(tracker.speedFor("thread-a")).toBe(100);
    tracker.reset();
    expect(tracker.speedFor("thread-a")).toBeUndefined();
    // The window is gone too, so the next observation starts a new one.
    tracker.observe(sample("turn-1", 400, 3000));
    expect(tracker.speedFor("thread-a")).toBeUndefined();
  });
});

describe("Codex native Usage observations", () => {
  it("maps thread token usage into the Host Usage shape", () => {
    expect(
      observeCodexTokenUsage({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "native-thread",
          turnId: "native-turn",
          tokenUsage: {
            total: {
              totalTokens: 1_000,
              inputTokens: 800,
              cachedInputTokens: 600,
              cacheWriteInputTokens: 10,
              outputTokens: 200,
              reasoningOutputTokens: 50,
            },
            last: {
              totalTokens: 240,
              inputTokens: 200,
              cachedInputTokens: 150,
              cacheWriteInputTokens: 5,
              outputTokens: 40,
              reasoningOutputTokens: 10,
            },
            modelContextWindow: 2_000,
          },
        },
      }),
    ).toEqual({
      threadId: "native-thread",
      turnId: "native-turn",
      usage: {
        totalTokens: 1_000,
        inputTokens: 800,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 10,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        contextUsedTokens: 240,
        contextWindowTokens: 2_000,
        cacheHitRatePercent: 75,
      },
    });
  });

  it("maps account rate-limit windows to the existing five-hour and seven-day fields", () => {
    expect(
      observeCodexRateLimits({
        id: "internal",
        result: {
          rateLimits: {
            primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1_800 },
            secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 2_400 },
          },
          rateLimitsByLimitId: null,
        },
      }),
    ).toEqual({
      planFiveHourUsedPercent: 2,
      planFiveHourResetsAtUnix: 1_800,
      planSevenDayUsedPercent: 8,
      planSevenDayResetsAtUnix: 2_400,
    });
  });

  it("ignores model-specific buckets and keeps only the generic account limit", () => {
    expect(
      observeCodexRateLimits({
        id: "internal",
        result: {
          rateLimits: {
            primary: { usedPercent: 11, windowDurationMins: 10_080, resetsAt: 3_000 },
            secondary: null,
          },
          rateLimitsByLimitId: {
            codex_model: {
              primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 4_000 },
              secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 5_000 },
            },
          },
        },
      }),
    ).toEqual({
      planSevenDayUsedPercent: 11,
      planSevenDayResetsAtUnix: 3_000,
    });
  });

  it("ignores model-specific rolling notifications", () => {
    expect(
      observeCodexRateLimits({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex_spark",
            primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 4_000 },
            secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 5_000 },
          },
        },
      }),
    ).toBeNull();
  });

  it("accepts a generic rolling notification with only a weekly window", () => {
    expect(
      observeCodexRateLimits({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: null,
            secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 5_000 },
          },
        },
      }),
    ).toEqual({
      planSevenDayUsedPercent: 12,
      planSevenDayResetsAtUnix: 5_000,
    });
  });

  it("projects generic Codex windows into the shared Credits snapshot", () => {
    expect(
      projectCodexRateLimitsToCredits({
        planFiveHourUsedPercent: 15,
        planFiveHourResetsAtUnix: 1_800,
        planSevenDayUsedPercent: 25,
        planSevenDayResetsAtUnix: 2_400,
      }),
    ).toEqual({
      usedPercent: 15,
      periodType: "five_hour",
      resetsAt: new Date(1_800 * 1000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          usagePercent: 25,
          resetsAt: new Date(2_400 * 1000).toISOString(),
        },
      ],
    });
  });

  it("reads banked reset cards and the soonest available expiry", () => {
    expect(
      observeCodexRateLimitResetCredits({
        id: "internal",
        result: {
          rateLimits: { primary: { usedPercent: 2, windowDurationMins: 300 } },
          rateLimitResetCredits: {
            availableCount: 2,
            credits: [
              {
                id: "later",
                resetType: "codexRateLimits",
                status: "available",
                grantedAt: 1_000,
                expiresAt: 4_000,
                title: "Full reset",
                description: null,
              },
              {
                id: "soon",
                resetType: "codexRateLimits",
                status: "available",
                grantedAt: 1_100,
                expiresAt: 2_400,
                title: "Full reset",
                description: null,
              },
              {
                id: "used",
                resetType: "codexRateLimits",
                status: "redeemed",
                grantedAt: 900,
                expiresAt: 1_200,
                title: "Full reset",
                description: null,
              },
            ],
          },
        },
      }),
    ).toEqual({
      availableCount: 2,
      nextExpiresAtUnix: 2_400,
      expiresAtUnix: [2_400, 4_000],
    });
  });

  it("omits reset cards when none are available", () => {
    expect(
      observeCodexRateLimitResetCredits({
        result: { rateLimitResetCredits: { availableCount: 0, credits: [] } },
      }),
    ).toBeNull();
  });

  it("projects reset-card inventory onto the Credits snapshot", () => {
    expect(
      projectCodexRateLimitsToCredits(
        {
          planFiveHourUsedPercent: 15,
          planFiveHourResetsAtUnix: 1_800,
        },
        { availableCount: 2, nextExpiresAtUnix: 2_400, expiresAtUnix: [2_400, 4_000] },
      ),
    ).toEqual({
      usedPercent: 15,
      periodType: "five_hour",
      resetsAt: new Date(1_800 * 1000).toISOString(),
      resetCredits: {
        availableCount: 2,
        nextExpiresAt: new Date(2_400 * 1000).toISOString(),
        expiresAt: [new Date(2_400 * 1000).toISOString(), new Date(4_000 * 1000).toISOString()],
      },
    });
  });

  it("projects a weekly-only Codex account without inventing a five-hour window", () => {
    expect(
      projectCodexRateLimitsToCredits({
        planSevenDayUsedPercent: 41,
        planSevenDayResetsAtUnix: 2_400,
      }),
    ).toEqual({
      usedPercent: 41,
      periodType: "seven_day",
      resetsAt: new Date(2_400 * 1000).toISOString(),
    });
  });
});
