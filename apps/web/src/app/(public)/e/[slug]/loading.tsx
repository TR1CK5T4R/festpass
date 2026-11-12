export default function Loading() {
  return (
    <div className="flex animate-pulse flex-col gap-6" role="status" aria-label="Loading event">
      <div className="aspect-[3/1] rounded-card bg-line" />
      <div className="h-9 w-2/3 rounded-control bg-line" />
      <div className="h-20 rounded-control bg-line" />
    </div>
  );
}
