import { useEffect, useRef, useState } from "react";

export function useSuccessMessage() {
  const [message, update] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const setMessage = (value: string) => {
    clearTimeout(timer.current);
    update(value);
    if (value) timer.current = setTimeout(() => update(""), 5000);
  };
  return [message, setMessage] as const;
}
