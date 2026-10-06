import { useState } from "react";
import { OnboardingFrame } from "./Onboarding";
import { OwnerPreferenceSettings } from "./SettingsGeneral";
import { SettingsModelServices } from "./SettingsModelServices";

export function ModelSettingsScreen({
  onboarding = false,
  embedded = false,
  progress = false,
  onDone,
}: {
  onboarding?: boolean;
  embedded?: boolean;
  progress?: boolean;
  onDone(): void;
}) {
  const [connectionsVersion, setConnectionsVersion] = useState(0);
  const content = (
    <>
      <SettingsModelServices onChanged={() => setConnectionsVersion((value) => value + 1)} />
      <OwnerPreferenceSettings key={connectionsVersion} />
    </>
  );
  if (embedded) return <section aria-label="模型服务配置">{content}</section>;
  return (
    <OnboardingFrame
      step={progress ? 3 : undefined}
      avatar={{ character: "round", accent: "green", size: 64 }}
      title={onboarding ? "给 Bot 选一个模型" : "模型服务"}
      description="连接模型服务，再指定 Bot 的默认模型。以后可以在设置里更换。"
      width={560}
      offset={56}
      titleId="model-title"
    >
      {content}
      <button className="ob-pill" type="button" onClick={onDone}>
        完成
      </button>
      <button className="ob-setup-link" type="button" onClick={onDone}>
        {onboarding ? "稍后再设置" : "返回设置"}
      </button>
      <span className="ob-setup-footnote">获取列表与保存不会发送对话或生成内容。</span>
    </OnboardingFrame>
  );
}
