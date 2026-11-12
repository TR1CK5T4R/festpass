// Shown while a page that isn't cached yet is rendered on the server.
export default function Loading() {
  return (
    <div className="flex animate-pulse flex-col gap-6" role="status" aria-label="Loading">
      <div className="h-8 w-72 rounded-control bg-line" />
      <div className="grid gap-6 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-56 rounded-card bg-line" />
        ))}
      </div>
    </div>
  );
}
