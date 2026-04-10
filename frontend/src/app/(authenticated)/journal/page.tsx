"use client";

import { JournalPanel } from "@/components/journal/journal-panel";

export default function JournalPage() {
  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col">
      <JournalPanel />
    </div>
  );
}
