import { Coins } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { useCreditStatus, type CreditAction } from "../../lib/creditStatus";

interface CreditBadgeProps {
  action?: CreditAction;
  chat?: boolean;
  cost?: number;
  label?: string;
}

export function CreditBadge({ action, chat = false, cost = 0, label = "本次" }: CreditBadgeProps) {
  const { user } = useAuth();
  const credits = useCreditStatus();
  const userBypassesCredits = Boolean(user?.unlimitedCredits || user?.isVip);
  const actionCost = action
    ? credits?.modelCallCosts?.[action] ?? credits?.chatCreditCost
    : undefined;

  if (chat) {
    if (userBypassesCredits || credits?.unlimitedCalls) {
      return <CreditPill tone="free" title="VIP 或无限积分账号对话不扣积分。">对话免积分</CreditPill>;
    }
    return (
      <CreditPill
        tone="charged"
        title={`每次助手对话扣除 ${credits?.chatCreditCost ?? 1} 积分。`}
      >
        对话消耗 {credits?.chatCreditCost ?? 1} 积分
      </CreditPill>
    );
  }

  if (userBypassesCredits || credits?.unlimitedCalls) {
    return (
      <CreditPill tone="free" title="VIP 或无限积分账号调用模型不扣积分。">
        {label}不消耗积分
      </CreditPill>
    );
  }

  if (action) {
    return (
      <CreditPill
        tone="charged"
        title={`${label}成功调用扣除 ${actionCost ?? 10} 积分。`}
      >
        {label}本次消耗 {actionCost ?? 10} 积分
      </CreditPill>
    );
  }

  const isFree = cost === 0;
  return (
    <CreditPill
      tone={isFree ? "free" : "charged"}
      title={isFree ? "本次动作不扣积分。" : `本次动作扣除 ${cost} 积分。`}
    >
      {label}{isFree ? "0 积分" : `${cost} 积分/次`}
    </CreditPill>
  );
}

function CreditPill({
  children,
  title,
  tone,
}: {
  children: React.ReactNode;
  title: string;
  tone: "free" | "charged";
}) {
  return (
    <span className={`credit-badge credit-badge--${tone}`} title={title}>
      <Coins aria-hidden="true" size={12} />
      {children}
    </span>
  );
}
