type Props = {
  name: string;
  status: string;
  department?: string | null;
  selected?: boolean;
  onClick?: () => void;
};

const statusColor: Record<string, string> = {
  online: "bg-forest-400",
  degraded: "bg-saffron-400",
  offline: "bg-red-500",
  unknown: "bg-slate-400",
};

export default function CameraMarker({ name, status, department, selected, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition ${
        selected ? "bg-white/10 ring-1 ring-saffron-400/60" : "hover:bg-white/5"
      }`}
    >
      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusColor[status] || statusColor.unknown}`} />
      <span className="min-w-0">
        <span className="block truncate font-medium text-chalk">{name}</span>
        <span className="block truncate text-xs text-chalk/55">
          {department || "Unassigned"} · {status}
        </span>
      </span>
    </button>
  );
}
