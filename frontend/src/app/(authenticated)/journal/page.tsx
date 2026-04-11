"use client";

import { JournalPanel } from "@/components/journal/journal-panel";

export default function JournalPage() {
  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 4rem)" }}>
      <JournalPanel />
    </div>
  );
}
