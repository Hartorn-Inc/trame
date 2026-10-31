import { h, type VNode } from 'preact';

export interface PadlockIconProps {
  size?: 20 | 24;
  className?: string;
  testId?: string;
}

const PADLOCK_STROKE_WIDTH = 1.75;

const PADLOCK_LOCKED_PATHS = [
  'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
  'M8 11V7a4 4 0 0 1 8 0v4',
  'M12 15v2',
] as const;

const PADLOCK_UNLOCKED_PATHS = [
  'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
  'M8 11V7a4 4 0 0 1 7.46-2',
  'M12 15v2',
] as const;

export function PadlockLockedIcon(props: PadlockIconProps): VNode<any> {
  const size = props.size ?? 20;
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': PADLOCK_STROKE_WIDTH,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      class: props.className,
      'data-testid': props.testId ?? 'atlas-icon-PadlockLockedIcon',
      'data-icon': 'PadlockLockedIcon',
    },
    PADLOCK_LOCKED_PATHS.map((d, idx) => h('path', { key: idx, d })),
  );
}

export function PadlockUnlockedIcon(props: PadlockIconProps): VNode<any> {
  const size = props.size ?? 20;
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': PADLOCK_STROKE_WIDTH,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      class: props.className,
      'data-testid': props.testId ?? 'atlas-icon-PadlockUnlockedIcon',
      'data-icon': 'PadlockUnlockedIcon',
    },
    PADLOCK_UNLOCKED_PATHS.map((d, idx) => h('path', { key: idx, d })),
  );
}
