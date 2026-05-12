export interface VoiceConsoleKeyState {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}

export function shouldSubmitVoiceConsoleKey(event: VoiceConsoleKeyState): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
