import { Camera, QrCode, ClipboardList, ChevronRight, Check } from 'lucide-react';
import type { CaptureMethod } from './types';

interface MethodCard {
  method:       CaptureMethod;
  icon:         React.ReactNode;
  title:        string;
  subtitle:     string;
  accent:       string;
  iconBg:       string;
  iconActiveBg: string;
  dot:          string;
}

const CARDS: MethodCard[] = [
  {
    method:       'BUSINESS_CARD',
    icon:         <Camera className="w-7 h-7" />,
    title:        'Scan Business Card',
    subtitle:     'Photo → AI extracts contact details',
    accent:       'from-amber-500 to-orange-500',
    iconBg:       'bg-amber-50 text-amber-600',
    iconActiveBg: 'bg-amber-100/20 text-white',
    dot:          'bg-amber-500',
  },
  {
    method:       'QR',
    icon:         <QrCode className="w-7 h-7" />,
    title:        'Scan QR Code',
    subtitle:     'Instant contact from QR or vCard',
    accent:       'from-teal-500 to-cyan-500',
    iconBg:       'bg-teal-50 text-teal-600',
    iconActiveBg: 'bg-teal-100/20 text-white',
    dot:          'bg-teal-500',
  },
  {
    method:       'MANUAL',
    icon:         <ClipboardList className="w-7 h-7" />,
    title:        'Manual Entry',
    subtitle:     'Type in lead details directly',
    accent:       'from-blue-500 to-sky-500',
    iconBg:       'bg-blue-50 text-blue-600',
    iconActiveBg: 'bg-blue-100/20 text-white',
    dot:          'bg-blue-500',
  },
];

interface Props {
  onSelect:     (method: CaptureMethod) => void;
  activeMethod?: CaptureMethod | null;
}

export function CaptureMethodPicker({ onSelect, activeMethod }: Props) {
  return (
    // Mobile: vertical stack for thumb-friendly one-handed use.
    // Desktop: 3-column grid.
    <div className="flex flex-col gap-3 md:grid md:grid-cols-3 md:gap-4">
      {CARDS.map((card) => {
        const isActive = activeMethod === card.method;
        return (
          <button
            key={card.method}
            onClick={() => onSelect(card.method)}
            className={[
              // Base — large enough for comfortable thumb tap
              'group relative flex items-center gap-4 rounded-2xl border',
              'px-4 py-4 text-left transition-all duration-150',
              // Desktop layout adjusts to card style
              'md:flex-col md:items-start md:p-5',
              // Tap feedback
              'active:scale-[0.97]',
              isActive
                ? 'bg-stone-900 border-stone-900 shadow-md'
                : 'bg-white border-stone-200 shadow-sm hover:shadow-md hover:border-stone-300',
            ].join(' ')}
          >
            {/* Gradient accent line — top edge on inactive hover */}
            {!isActive && (
              <div className={`absolute inset-x-0 top-0 h-0.5 rounded-t-2xl
                bg-gradient-to-r ${card.accent}
                opacity-0 group-hover:opacity-100 transition-opacity duration-200`} />
            )}

            {/* Icon container */}
            <div className={[
              'shrink-0 w-14 h-14 md:w-12 md:h-12 rounded-2xl flex items-center justify-center',
              'transition-all duration-150',
              isActive ? `bg-white/15 text-white` : `${card.iconBg} group-hover:scale-105`,
            ].join(' ')}>
              {card.icon}
            </div>

            {/* Text */}
            <div className="flex-1 md:mt-3 min-w-0">
              <h2 className={`text-[15px] font-semibold leading-snug ${isActive ? 'text-white' : 'text-stone-900'}`}>
                {card.title}
              </h2>
              <p className={`mt-0.5 text-xs leading-relaxed ${isActive ? 'text-stone-300' : 'text-stone-500'}`}>
                {card.subtitle}
              </p>
            </div>

            {/* Right indicator (mobile only) */}
            <div className="shrink-0 md:hidden">
              {isActive
                ? <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center">
                    <Check className="w-4 h-4 text-white" />
                  </div>
                : <ChevronRight className="w-5 h-5 text-stone-300 group-hover:text-stone-400 transition-colors" />
              }
            </div>
          </button>
        );
      })}
    </div>
  );
}
