import type { ReactNode } from 'react';
import { isDesktop } from '../lib/native';
import Console from '../surfaces/console/Console';
import { StartupGate } from '../surfaces/recovery/Recovery';
import NativeApplication from './NativeApplication';
import '../styles/style-picker.css';

export default function ConsoleApplication({ preview }: { preview?: ReactNode }) {
  const application = <NativeApplication><Console />{preview}</NativeApplication>;
  // A failed database check must never mount a task store or draft subscriptions.
  return isDesktop ? <StartupGate>{application}</StartupGate> : application;
}
