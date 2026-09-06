import { forwardRef } from "react";

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

const CameraMarker = forwardRef<HTMLButtonElement, Props>(function CameraMarker(
  { name, status, department, selected, onClick },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 border-l-4 px-3 py-2.5 text-left transition ${
        selected
          ? "border-red-500 bg-white/[0.08]"
          : "border-transparent hover:bg-white/[0.04]"
      }`}
    >
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusColor[status] || statusColor.unknown}`}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-chalk">{name}</span>
        <span className="block truncate font-mono text-[10px] text-chalk/50">
          {department || "Unassigned"} · {status}
        </span>
      </span>
    </button>
  );
});

export default CameraMarker;
