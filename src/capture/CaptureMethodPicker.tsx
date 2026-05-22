import { Camera, QrCode, ClipboardList, ChevronRight, Check } from 'lucide-react';
import type { CaptureMethod } from './types';

interface MethodCard {
  method: CaptureMethod;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accent: string;
  iconBg: string;
  iconActiveBg: string;
}

const CARDS: MethodCard[] = [
  {
    method: 'BUSINESS_CARD',
    icon: <Camera className="w-7 h-7" />,
    title: 'Scan Business Card',
    subtitle: 'Capture front and back of visiting card',
    accent: 'from-amber-500 to-orange-500',
    iconBg: 'bg-amber-50 text-amber-600',
    iconActiveBg: 'bg-amber-100 text-amber-700',
  },
  {
    method: 'QR',
    icon: <QrCode className="w-7 h-7" />,
    title: 'Scan QR Code',
    subtitle: 'Extract contact details from QR or vCard',
    accent: 'from-teal-500 to-cyan-500',
    iconBg: 'bg-teal-50 text-teal-600',
    iconActiveBg: 'bg-teal-100 text-teal-700',
  },
  {
    method: 'MANUAL',
    icon: <ClipboardList className="w-7 h-7" />,
    title: 'Quick Manual Entry',
    subtitle: 'Quickly enter lead information manually',
    accent: 'from-blue-500 to-sky-500',
    iconBg: 'bg-blue-50 text-blue-600',
    iconActiveBg: 'bg-blue-100 text-blue-700',
  },
];

interface Props {
  onSelect: (method: CaptureMethod) => void;
  activeMethod?: CaptureMethod | null;
}

export function CaptureMethodPicker({ onSelect, activeMethod }: Props) {
  return (
    <div className="flex flex-col gap-3 md:grid md:grid-cols-3 md:gap-4">
      {CARDS.map((card) => {
        const isActive = activeMethod === card.method;
        return (
          <button
            key={card.method}
            onClick={() => onSelect(card.method)}
            className={`group relative flex items-center gap-4 md:flex-col md:items-start rounded-2xl border px-4 py-4 md:p-5 text-left transition-all duration-150
              ${isActive
                ? 'bg-stone-900 border-stone-900 shadow-md'
                : 'bg-white border-stone-200 shadow-sm hover:shadow-md hover:border-stone-300 active:scale-[0.985]'
              }`}
          >
            {/* Gradient accent line — only on inactive hover */}
            {!isActive && (
              <div className={`absolute inset-x-0 top-0 h-0.5 rounded-t-2xl bg-gradient-to-r ${card.accent} opacity-0 group-hover:opacity-100 transition-opacity duration-200`} />
            )}

            {/* Icon */}
            <div className={`flex-shrink-0 w-12 h-12 md:w-11 md:h-11 rounded-xl flex items-center justify-center transition-all duration-150
              ${isActive ? 'bg-white/15 text-white' : `${card.iconBg} group-hover:scale-105`}`}>
              {card.icon}
            </div>

            {/* Text */}
            <div className="flex-1 md:mt-3 min-w-0">
              <h2 className={`text-sm font-semibold leading-snug ${isActive ? 'text-white' : 'text-stone-900'}`}>
                {card.title}
              </h2>
              <p className={`mt-0.5 text-xs leading-relaxed line-clamp-2 ${isActive ? 'text-stone-300' : 'text-stone-500'}`}>
                {card.subtitle}
              </p>
            </div>

            {/* Right indicator */}
            <div className="flex-shrink-0 md:hidden">
              {isActive
                ? <Check className="w-4 h-4 text-white" />
                : <ChevronRight className="w-4 h-4 text-stone-300 group-hover:text-stone-400 transition-colors" />
              }
            </div>
          </button>
        );
      })}
    </div>
  );
}
