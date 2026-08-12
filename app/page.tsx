export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-xl text-center space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">vibe-stack-supabase</h1>
        <p className="text-neutral-500">
          Edit{" "}
          <code className="bg-neutral-100 px-1.5 py-0.5 rounded text-sm">
            app/page.tsx
          </code>{" "}
          to start building.
        </p>
        <p className="text-xs text-neutral-400">
          See{" "}
          <code className="bg-neutral-100 px-1.5 py-0.5 rounded">CLAUDE.md</code>{" "}
          for project conventions and gstack workflow.
        </p>
      </div>
    </main>
  );
}
