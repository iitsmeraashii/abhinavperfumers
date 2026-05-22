import { Camera, QrCode, ClipboardList, ChevronRight } from 'lucide-react';

interface CaptureOption {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accent: string;
  iconBg: string;
  onClick?: () => void;
}

export default function CaptureLeadPage() {
  const options: CaptureOption[] = [
    {
      icon: <Camera className="w-8 h-8" />,
      title: 'Scan Business Card',
      subtitle: 'Capture front and back of visiting card',
      accent: 'from-amber-500 to-orange-500',
      iconBg: 'bg-amber-50 text-amber-600',
    },
    {
      icon: <QrCode className="w-8 h-8" />,
      title: 'Scan QR Code',
      subtitle: 'Extract contact details from QR or vCard',
      accent: 'from-teal-500 to-cyan-500',
      iconBg: 'bg-teal-50 text-teal-600',
    },
    {
      icon: <ClipboardList className="w-8 h-8" />,
      title: 'Quick Manual Entry',
      subtitle: 'Quickly enter lead information manually',
      accent: 'from-blue-500 to-sky-500',
      iconBg: 'bg-blue-50 text-blue-600',
    },
  ];

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50 flex flex-col">
      <div className="flex-1 w-full max-w-lg mx-auto px-5 pt-10 pb-safe-bottom pb-10 flex flex-col">

        {/* Header */}
        <div className="mb-10">
          <h1 className="text-2xl font-bold text-stone-900 tracking-tight">Capture New Lead</h1>
          <p className="mt-1.5 text-base text-stone-500 leading-relaxed">
            Choose how you want to capture lead details
          </p>
        </div>

        {/* Option cards */}
        <div className="flex flex-col gap-4 sm:grid sm:grid-cols-1 md:grid-cols-3 md:gap-5">
          {options.map((opt) => (
            <button
              key={opt.title}
              onClick={opt.onClick}
              className="group relative flex items-center gap-5 md:flex-col md:items-start bg-white rounded-2xl border border-stone-200 px-5 py-6 md:p-6 text-left shadow-sm hover:shadow-md hover:border-stone-300 active:scale-[0.985] transition-all duration-150 cursor-pointer"
            >
              {/* Gradient accent line */}
              <div className={`absolute inset-x-0 top-0 h-1 rounded-t-2xl bg-gradient-to-r ${opt.accent} opacity-0 group-hover:opacity-100 transition-opacity duration-200`} />

              {/* Icon */}
              <div className={`flex-shrink-0 w-16 h-16 md:w-14 md:h-14 rounded-2xl flex items-center justify-center ${opt.iconBg} transition-transform duration-150 group-hover:scale-105`}>
                {opt.icon}
              </div>

              {/* Text */}
              <div className="flex-1 md:mt-4">
                <h2 className="text-base font-semibold text-stone-900 leading-snug">{opt.title}</h2>
                <p className="mt-1 text-sm text-stone-500 leading-relaxed">{opt.subtitle}</p>
              </div>

              {/* Chevron — mobile only */}
              <ChevronRight className="w-5 h-5 text-stone-300 flex-shrink-0 md:hidden group-hover:text-stone-400 transition-colors" />

              {/* Coming soon pill */}
              <span className="hidden md:inline-flex absolute bottom-4 right-4 items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-stone-100 text-stone-400 uppercase tracking-wide">
                Coming soon
              </span>
            </button>
          ))}
        </div>

        {/* Mobile coming-soon note */}
        <p className="mt-8 text-center text-xs text-stone-400 md:hidden">
          Features coming soon — tap to preview
        </p>
      </div>
    </div>
  );
}
