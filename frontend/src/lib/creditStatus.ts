import { useEffect, useState } from "react";
import { api } from "../api/client";

export type CreditAction =
  | "article_create"
  | "rewrite_candidate"
  | "visual_plan"
  | "visual_apply"
  | "template_extract";

export interface CreditStatus {
  balance: number;
  unlimited: boolean;
  isVip: boolean;
  chatCreditCost: number;
  unlimitedCalls: boolean;
  modelCallCosts?: Partial<Record<CreditAction, number>>;
}

let status: CreditStatus | null = null;
let request: Promise<CreditStatus | null> | null = null;
const listeners = new Set<(value: CreditStatus | null) => void>();

function setStatus(next: CreditStatus | null) {
  status = next;
  listeners.forEach(listener => listener(status));
}

export function resetCreditStatus() {
  setStatus(null);
}

export function refreshCreditStatus(): Promise<CreditStatus | null> {
  if (request) return request;
  request = api.get<CreditStatus>("/me/credits")
    .then(res => {
      setStatus(res.data);
      return res.data;
    })
    .catch(() => null)
    .finally(() => { request = null; });
  return request;
}

export function useCreditStatus(): CreditStatus | null {
  const [current, setCurrent] = useState<CreditStatus | null>(status);

  useEffect(() => {
    setCurrent(status);
    listeners.add(setCurrent);
    if (!status && !request) void refreshCreditStatus();
    return () => { listeners.delete(setCurrent); };
  }, []);

  return current;
}
