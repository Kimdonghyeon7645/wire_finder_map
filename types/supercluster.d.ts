declare module "supercluster" {
  import type { Feature, Point } from "geojson";

  export interface Options<P, C> {
    radius?: number;
    maxZoom?: number;
    minZoom?: number;
    minPoints?: number;
    extent?: number;
    nodeSize?: number;
    log?: boolean;
    generateId?: boolean;
    reduce?: (accumulated: C, properties: P) => void;
    map?: (properties: P) => C;
  }

  export default class Supercluster<P = Record<string, unknown>, C = P> {
    constructor(options?: Options<P, C>);
    load(points: Array<Feature<Point, P>>): this;
    getClusters(bbox: [number, number, number, number], zoom: number): Array<Feature<Point, P | (C & {
      cluster: true;
      cluster_id: number;
      point_count: number;
      point_count_abbreviated: string | number;
    })>>;
    getClusterExpansionZoom(clusterId: number): number;
  }
}
