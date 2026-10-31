import { h, type VNode } from 'preact';
import {
  ATLAS_ICON_PATHS,
  ATLAS_ICON_STROKE_WIDTH,
  type AtlasIconProps,
} from '../components/icons/AtlasIcons.tsx';

export function PadlockLockedIcon(props: AtlasIconProps): VNode<any> {
  const size = props.size ?? 20;
  const paths = ATLAS_ICON_PATHS.PadlockLockedIcon;
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': ATLAS_ICON_STROKE_WIDTH,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      class: props.className,
      'data-testid': props.testId ?? 'atlas-icon-PadlockLockedIcon',
      'data-icon': 'PadlockLockedIcon',
    },
    paths.map((d, idx) => h('path', { key: idx, d })),
  );
}

export function PadlockUnlockedIcon(props: AtlasIconProps): VNode<any> {
  const size = props.size ?? 20;
  const paths = ATLAS_ICON_PATHS.PadlockUnlockedIcon;
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': ATLAS_ICON_STROKE_WIDTH,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      class: props.className,
      'data-testid': props.testId ?? 'atlas-icon-PadlockUnlockedIcon',
      'data-icon': 'PadlockUnlockedIcon',
    },
    paths.map((d, idx) => h('path', { key: idx, d })),
  );
}
