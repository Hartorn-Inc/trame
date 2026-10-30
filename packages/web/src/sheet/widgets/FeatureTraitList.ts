import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export interface FeatureItem {
  id: string;
  name: string;
  source: string;
  description: string;
}

export interface FeatureTraitListOutput {
  id: string;
  features: FeatureItem[];
  expandedIds: string[];
  toggleFeature: (featureId: string) => void;
  clickFeatureHeader: (featureId: string) => void;
  isExpanded: (featureId: string) => boolean;
}

export function FeatureTraitList(context: WidgetRenderContext): FeatureTraitListOutput {
  const rawFeatures = Array.isArray(context.boundValues.features) ? context.boundValues.features : [];
  const features: FeatureItem[] = rawFeatures.map((f: any) => ({
    id: String(f.id ?? ""),
    name: String(f.name ?? "Feature"),
    source: String(f.source ?? "General"),
    description: String(f.description ?? ""),
  }));

  const expandedSet = new Set<string>();

  const toggle = (featureId: string) => {
    if (expandedSet.has(featureId)) {
      expandedSet.delete(featureId);
    } else {
      expandedSet.add(featureId);
    }
  };

  return {
    id: context.id,
    features,
    get expandedIds() {
      return Array.from(expandedSet);
    },
    toggleFeature: toggle,
    clickFeatureHeader: toggle,
    isExpanded: (featureId: string) => expandedSet.has(featureId),
  };
}
