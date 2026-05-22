import { Camera, QrCode, ClipboardList, ChevronRight } from 'lucide-react';
import type { CaptureMethod } from './types';

interface MethodCard {
  method: CaptureMethod;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accent: string;
  iconBg: string;
}

const CARDS: MethodCard[] = [
  {
    method: 'BUSINESS_CARD',
    icon: <Camera className="w-8 h-8" />,
    title: 'Scan Business Card',
    subtitle: 'Capture front and back of visiting card',
    accent: 'from-amber-500 to-orange-500',
    iconBg: 'bg-amber-50 text-amber-600',
  },
  {
    method: 'QR',
    icon: <QrCode className="w-8 h-8" />,
    title: 'Scan QR Code',
    subtitle: 'Extract contact details from QR or vCard',
    accent: 'from-teal-500 to-cyan-500',
    iconBg: 'bg-teal-50 text-teal-600',
  },
  {
    method: 'MANUAL',
    icon: <ClipboardList className="w-8 h-8" />,
    title: 'Quick Manual Entry',
    subtitle: 'Quickly enter lead information manually',
    accent: 'from-blue-500 to-sky-500',
    iconBg: 'bg-blue-50 text-blue-600',
  },
];

interface Props {
  onSelect: (method: CaptureMethod) => void;
}

export function CaptureMethodPicker({ onSelect }: Props) {
  return (
    <div className="flex flex-col gap-4 md:grid md:grid-cols-3 md:gap-5">
      {CARDS.map((card) => (
        <button
          key={card.method}
          onClick={() => onSelect(card.method)}
          className="group relative flex items-center gap-5 md:flex-col md:items-start bg-white rounded-2xl border border-stone-200 px-5 py-6 md:p-6 text-left shadow-sm hover:shadow-md hover:border-stone-300 active:scale-[0.985] transition-all duration-150"
        >
          <div className={`absolute inset-x-0 top-0 h-1 rounded-t-2xl bg-gradient-to-r ${card.accent} opacity-0 group-hover:opacity-100 transition-opacity duration-200`} />

          <div className={`flex-shrink-0 w-16 h-16 md:w-14 md:h-14 rounded-2xl flex items-center justify-center ${card.iconBg} transition-transform duration-150 group-hover:scale-105`}>
            {card.icon}
          </div>

          <div className="flex-1 md:mt-4">
            <h2 className="text-base font-semibold text-stone-900 leading-snug">{card.title}</h2>
            <p className="mt-1 text-sm text-stone-500 leading-relaxed">{card.subtitle}</p>
          </div>

          <ChevronRight className="w-5 h-5 text-stone-300 flex-shrink-0 md:hidden group-hover:text-stone-400 transition-colors" />
        </button>
      ))}
    </div>
  );
}
