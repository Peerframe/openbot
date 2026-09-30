import type { ReactNode } from "react";

interface IconProps {
  children: ReactNode;
  size?: number;
}

function Icon({ children, size = 18 }: IconProps) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      {children}
    </svg>
  );
}

const strokeProps = {
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.8,
};

export function HashIcon() {
  return (
    <Icon size={16}>
      <path d="M9 3 7 21M17 3l-2 18M4 9h17M3 15h17" {...strokeProps} />
    </Icon>
  );
}

export function BotIcon() {
  return (
    <Icon size={17}>
      <rect x="4" y="7" width="16" height="12" rx="4" {...strokeProps} />
      <path d="M12 7V4M9 13h.01M15 13h.01M8 19v2M16 19v2" {...strokeProps} />
    </Icon>
  );
}

export function NodeIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="12" rx="2" {...strokeProps} />
      <path d="M8 20h8M12 16v4" {...strokeProps} />
    </Icon>
  );
}

export function ApprovalIcon() {
  return (
    <Icon>
      <path d="M12 3.5 19 6v5.3c0 4.5-2.8 7.6-7 9.2-4.2-1.6-7-4.7-7-9.2V6Z" {...strokeProps} />
      <path d="m8.5 12 2.2 2.2 4.8-5" {...strokeProps} />
    </Icon>
  );
}

export function BellIcon() {
  return (
    <Icon>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5Z" {...strokeProps} />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" {...strokeProps} />
    </Icon>
  );
}

export function AuditIcon() {
  return (
    <Icon>
      <path
        d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 17 19.5H7A1.5 1.5 0 0 1 5.5 18V6A1.5 1.5 0 0 1 7 4.5Z"
        {...strokeProps}
      />
      <path d="M9 9h6M9 12.5h6M9 16h3.5" {...strokeProps} />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon size={16}>
      <path d="M12 5v14M5 12h14" {...strokeProps} />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="m6 6 12 12M18 6 6 18" {...strokeProps} />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon size={14}>
      <path d="m5 12 4 4L19 6" {...strokeProps} />
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="10.5" cy="10.5" r="6.5" {...strokeProps} />
      <path d="m16 16 4 4" {...strokeProps} />
    </Icon>
  );
}
export function ComposeIcon() {
  return (
    <Icon>
      <path
        d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M15 4l5 5M10 14l1-5 7-7 5 5-7 7-5 1Z"
        {...strokeProps}
      />
    </Icon>
  );
}
export function SettingsIcon() {
  return (
    <Icon>
      <path d="M4 7h16M4 17h16" {...strokeProps} />
      <circle cx="9" cy="7" r="3" fill="var(--panel)" {...strokeProps} />
      <circle cx="16" cy="17" r="3" fill="var(--panel)" {...strokeProps} />
    </Icon>
  );
}
export function SendIcon() {
  return (
    <Icon>
      <path d="M12 20V4m-7 7 7-7 7 7" {...strokeProps} />
    </Icon>
  );
}

export function PanelRightIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="3" {...strokeProps} />
      <path d="M16 4v16" {...strokeProps} />
    </Icon>
  );
}
export function AutomationIcon() {
  return (
    <Icon>
      <circle cx="12" cy="13" r="8" {...strokeProps} />
      <path d="M12 9v4l3 2M5 3 2 6M19 3l3 3M8 2h8" {...strokeProps} />
    </Icon>
  );
}
export function SkillIcon() {
  return (
    <Icon>
      <path d="m14 3 7 7-7 7-7-7 7-7ZM6 12l-3 3 6 6 3-3" {...strokeProps} />
      <path d="m14 8 2 2-2 2-2-2 2-2Z" {...strokeProps} />
    </Icon>
  );
}

export function PanelLeftIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="3" {...strokeProps} />
      <path d="M8 4v16" {...strokeProps} />
    </Icon>
  );
}
export function BackIcon() {
  return (
    <Icon>
      <path d="m14 5-7 7 7 7M7 12h14" {...strokeProps} />
    </Icon>
  );
}
export function ForwardIcon() {
  return (
    <Icon>
      <path d="m10 5 7 7-7 7M17 12H3" {...strokeProps} />
    </Icon>
  );
}

export function ShareIcon() {
  return (
    <Icon>
      <path d="M12 15V3m-4 4 4-4 4 4M8 10H5v11h14V10h-3" {...strokeProps} />
    </Icon>
  );
}
