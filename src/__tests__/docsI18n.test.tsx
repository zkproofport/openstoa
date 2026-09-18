// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import LegacyGuide from "@/components/docs/LegacyGuide";
import CliGuide from "@/components/docs/CliGuide";
import LoginGuide from "@/components/docs/LoginGuide";
import { CLI_REFERENCE } from "@/lib/docs/cliReference";
import en from "@/lib/i18n/locales/docs.en.json";
import ko from "@/lib/i18n/locales/docs.ko.json";
import { I18nProvider, useTranslation } from "@/lib/i18n/I18nProvider";
vi.mock("@/components/Header", () => ({ default: () => null }));
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
function Switch() {
  const { setLocale } = useTranslation();
  return <button onClick={() => setLocale("ko")}>한국어</button>;
}
describe("agent guide translations", () => {
  it("provides the same nonempty translations and rich-text slots in both locales", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ko[key].trim(), key).not.toBe("");
      expect((ko[key].match(/\{\{\w+\}\}/g) ?? []).sort(), key).toEqual(
        (en[key].match(/\{\{\w+\}\}/g) ?? []).sort(),
      );
    }
  });
  it("switches the full guide to Korean while preserving commands and reference links", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <I18nProvider initialLocale="en">
            <Switch />
            <LegacyGuide section="intro" /><LoginGuide /><LegacyGuide section="rest" /><CliGuide />
          </I18nProvider>,
        ),
      );
      expect([...container.querySelectorAll('[data-cli-command]')].map((node) => node.getAttribute('data-cli-command')).sort()).toEqual(CLI_REFERENCE.map((row) => row.command).sort());
      expect(container.querySelector('#cli-guide')).not.toBeNull();
      expect(container.querySelector('[data-login-guide]')?.textContent).toContain('openstoa login');
      expect(container.querySelector('[data-login-guide]')?.textContent).toContain('openstoa_authenticate');
      expect(container.textContent).not.toContain('Previous proof-login');
      const commands = [...container.querySelectorAll("pre")].map(
        (node) => node.textContent,
      );
      expect(commands.length).toBeGreaterThan(5);
      const links = [...container.querySelectorAll("a")].map((node) =>
        node.getAttribute("href"),
      );
      act(() => container.querySelector("button")!.click());
      expect(container.querySelector("#step4")?.textContent).toBe(
        "REST 예시: 토픽 참여",
      );
      expect(container.textContent).toContain("증명하는 내용");
      expect(container.textContent).toContain("알림 설정");
      expect(container.textContent).toContain("인증 배지는 기본으로 공개");
      expect(container.textContent).toContain(
        "직접 설정한 공개 여부는 인증이 만료되거나 다시 인증해도 유지",
      );
      expect(container.textContent).toContain(ko.cliOwnerBody);
      expect(container.querySelector('[id="path-a"]')).toBeNull();
      const ownerCommand = container.querySelector('[data-cli-command="apikey create"]');
      expect(ownerCommand).not.toBeNull();
      expect(ownerCommand?.parentElement?.querySelector('h3')?.textContent).toContain('계정 소유자');
      expect(container.textContent).not.toContain("Body shape — text");
      expect(container.textContent).not.toMatch(/\{\{\w+\}\}|docs\.[a-zA-Z]/);
      const koreanSamples = [...container.querySelectorAll("pre")].map(
        (node) => node.textContent ?? "",
      );
      const sampleKeys = (Object.keys(en) as (keyof typeof en)[]).filter((key) =>
        (key.startsWith("code") || key.startsWith("cliSample") || key === "cliSearchTerm")
        && commands.some(sample => sample?.includes(en[key])),
      );
      // Localized prose must not change executable commands or JSON field names.
      const executableLines = (sample: string) =>
        sample.split("\n").map((line) => line.replace(/\s*#.*$/, "")).join("\n");
      expect(koreanSamples.map((sample) => {
        let normalized = sample;
        for (const key of [...sampleKeys].sort((a, b) => ko[b].length - ko[a].length)) normalized = normalized.replaceAll(ko[key], en[key]);
        return executableLines(normalized);
      })).toEqual(commands.map((sample) => executableLines(sample ?? "")));
      for (const key of sampleKeys) {
        expect(koreanSamples.join("\n"), key).toContain(ko[key]);
        expect(koreanSamples.join("\n"), key).not.toContain(en[key]);
      }
      expect(koreanSamples.join("\n")).toMatch(/export AUTH="Authorization: Bearer \$(?!OPENSTOA_API_KEY)[A-Z_]+"/);
      expect(koreanSamples.join("\n")).toContain('X-OpenStoa-API-Key');
      expect(container.textContent).toContain("실명 확인이나 KYC를 뜻하지 않습니다");
      expect(
        [...container.querySelectorAll("a")].map((node) =>
          node.getAttribute("href"),
        ),
      ).toEqual(links);
    } finally {
      act(() => root.unmount());
      document.documentElement.lang = "en";
    }
  });
});
