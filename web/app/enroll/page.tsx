import Link from "next/link";
import { EnrollPanel } from "../components/EnrollPanel";

export const dynamic = "force-dynamic";

export default function EnrollPage() {
  return (
    <main className="atmosphere relative min-h-screen px-5 py-8 sm:px-8">
      <div className="relative z-10 mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl tracking-tight text-paper">
              Card enrolment
            </h1>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
              Bind a physical card to a student
            </p>
          </div>
          <Link
            href="/"
            className="border border-rule px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted transition-colors hover:border-amber hover:text-amber"
          >
            ← Gate board
          </Link>
        </header>
        <div className="livewire" />
        <EnrollPanel />
      </div>
    </main>
  );
}
