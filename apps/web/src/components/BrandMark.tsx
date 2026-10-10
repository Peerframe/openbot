// Logos for model providers and plugins (LobeHub icons, SVG Logos), falling back to a letter.
// Presentation only: a logo never says what a plugin may do.
import discord from "@iconify-icons/logos/discord-icon";
import figma from "@iconify-icons/logos/figma";
import github from "@iconify-icons/logos/github-icon";
import calendar from "@iconify-icons/logos/google-calendar";
import drive from "@iconify-icons/logos/google-drive";
import gmail from "@iconify-icons/logos/google-gmail";
import linear from "@iconify-icons/logos/linear-icon";
import notion from "@iconify-icons/logos/notion-icon";
import slack from "@iconify-icons/logos/slack-icon";
import x from "@iconify-icons/logos/x";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg?url";
import bailian from "@lobehub/icons-static-svg/icons/bailian-color.svg?url";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg?url";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg?url";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg?url";
import moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg?url";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?url";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg?url";
import siliconcloud from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg?url";
import volcengine from "@lobehub/icons-static-svg/icons/volcengine-color.svg?url";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg?url";
import type { CSSProperties } from "react";
import "./BrandMark.css";

/**
 * Real logos for plugins and model providers (owner request 2026-10-05). Logos identify the
 * service a plugin or connection talks to; they are presentation only and say nothing about what
 * a plugin may do. Provider marks: LobeHub icons (MIT). Plugin marks: SVG Logos (CC0). One-colour
 * marks follow the text colour so they stay visible in dark; an unknown service keeps its letter.
 */
type Mark = { src: string; mono?: true };

function iconifyUrl(icon: {
  body: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}) {
  const box = `${icon.left ?? 0} ${icon.top ?? 0} ${icon.width ?? 16} ${icon.height ?? 16}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${icon.body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const providerMarks: Record<string, Mark> = {
  openai: { src: openai, mono: true },
  anthropic: { src: anthropic, mono: true },
  gemini: { src: gemini },
  deepseek: { src: deepseek },
  moonshot: { src: moonshot, mono: true },
  // The Server names the Moonshot preset `kimi` in model connections.
  kimi: { src: moonshot, mono: true },
  openrouter: { src: openrouter, mono: true },
  siliconflow: { src: siliconcloud },
  dashscope: { src: bailian },
  zai: { src: zhipu },
  minimax: { src: minimax },
  ark: { src: volcengine },
};

/** Matched against a plugin's name and endpoint host, most specific first. */
const pluginMarks: [RegExp, Mark][] = [
  [/gmail|mail\.google/u, { src: iconifyUrl(gmail) }],
  [/google[\s-]*drive|drive\.google/u, { src: iconifyUrl(drive) }],
  [/google[\s-]*calendar|calendar\.google/u, { src: iconifyUrl(calendar) }],
  [/github/u, { src: iconifyUrl(github), mono: true }],
  [/slack/u, { src: iconifyUrl(slack) }],
  [/notion/u, { src: iconifyUrl(notion) }],
  [/linear/u, { src: iconifyUrl(linear), mono: true }],
  [/discord/u, { src: iconifyUrl(discord) }],
  [/figma/u, { src: iconifyUrl(figma) }],
  [/^x$|twitter|(^|\.)x\.com/u, { src: iconifyUrl(x), mono: true }],
];

export function providerMark(presetId: string | undefined): Mark | undefined {
  return presetId ? providerMarks[presetId] : undefined;
}

export function pluginMark(plugin: {
  name: string;
  endpoint?: string | undefined;
}): Mark | undefined {
  let host = "";
  try {
    host = plugin.endpoint ? new URL(plugin.endpoint).hostname : "";
  } catch {
    host = "";
  }
  const name = plugin.name.trim().toLocaleLowerCase();
  return pluginMarks.find(([pattern]) => pattern.test(name) || (host && pattern.test(host)))?.[1];
}

/** The logo, or the first letter of `label` when the service is unknown. */
export function BrandMark({
  mark,
  label,
  className,
}: {
  mark: Mark | undefined;
  label: string;
  className?: string;
}) {
  const classes = ["brand-mark", className].filter(Boolean).join(" ");
  if (!mark)
    return (
      <i className={`${classes} is-letter`} aria-hidden="true">
        {Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?"}
      </i>
    );
  if (mark.mono)
    return (
      <i
        className={`${classes} is-mono`}
        aria-hidden="true"
        style={{ "--brand-mark": `url("${mark.src}")` } as CSSProperties}
      />
    );
  return (
    <i className={classes} aria-hidden="true">
      <img src={mark.src} alt="" draggable={false} />
    </i>
  );
}
