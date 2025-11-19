import Vector from "./vector";

/**
 * Irregular grid that stores separate arrays for latitudes and longitudes
 * Used when data comes from Web Mercator projection or other non-uniform grids
 * Latitudes array contains unique latitude values (one per row)
 * Longitudes array contains unique longitude values (one per column)
 */
export default class IrregularGrid {
    private data: Vector[];
    private latitudes: number[];   // Array of unique latitudes (height elements)
    private longitudes: number[];  // Array of unique longitudes (width elements)
    private width: number;         // Number of longitude points
    private height: number;        // Number of latitude points
    private latMin: number;
    private latMax: number;
    private lonMin: number;
    private lonMax: number;
    private crossesIDL = false;

    // Precomputed/cached for performance
    private EPS = 1e-6;
    private normLongitudes: number[] | null = null;      // longitudes normalized to [0,360)
    private unrolledLongitudes: number[] | null = null;  // strictly increasing sequence for IDL bracketing
    private latAscending: boolean;                       // for non-IDL lat bracketing
    private lonAscending: boolean;                       // for non-IDL lon bracketing

    constructor(data: Vector[], latitudes: number[], longitudes: number[]) {
        this.data = data;
        this.latitudes = latitudes;
        this.longitudes = longitudes;
        this.width = longitudes.length;
        this.height = latitudes.length;

        // Detect IDL crossing
        this.crossesIDL = this.detectDateLineCrossing(longitudes);

        // Calculate bounds
        this.latMin = Math.min(...latitudes);
        this.latMax = Math.max(...latitudes);

        // Ascending flag for lats (used by binary search when not IDL)
        this.latAscending = latitudes[0] <= latitudes[latitudes.length - 1];

        if (this.crossesIDL) {
            // Precompute normalized and unrolled longitudes once
            this.normLongitudes = longitudes.map(lng => lng < 0 ? lng + 360 : lng);

            // Build the strictly increasing unrolled array
            this.unrolledLongitudes = new Array(this.normLongitudes.length);
            this.unrolledLongitudes[0] = this.normLongitudes[0];
            for (let i = 1; i < this.normLongitudes.length; i++) {
                let v = this.normLongitudes[i];
                if (v + this.EPS < this.normLongitudes[i - 1]) {
                    v += 360;
                }
                if (v + this.EPS < this.unrolledLongitudes[i - 1]) {
                    v += 360 * Math.ceil((this.unrolledLongitudes[i - 1] - v) / 360);
                }
                this.unrolledLongitudes[i] = v;
            }

            // Bounds from normalized values
            this.lonMin = Math.min(...this.normLongitudes);
            this.lonMax = Math.max(...this.normLongitudes);
            //console.log('IrregularGrid: IDL crossing detected, normalized bounds:', this.lonMin, 'to', this.lonMax);
        } else {
            this.lonMin = Math.min(...longitudes);
            this.lonMax = Math.max(...longitudes);
            this.lonAscending = longitudes[0] <= longitudes[longitudes.length - 1];
        }
    }

    private detectDateLineCrossing(longitudes: number[]): boolean {
        if (longitudes.length < 2) return false;

        let hasPositive = false;
        let hasNegative = false;

        for (const lng of longitudes) {
            if (lng > 90) hasPositive = true;
            if (lng < -90) hasNegative = true;

            if (hasPositive && hasNegative) {
                return true;
            }
        }

        return false;
    }

    get valueRange(): number[] {
        if (!this.data.length) {
            return [0, 0];
        }
        let min = this.data[0].intensity;
        let max = this.data[0].intensity;
        this.data.forEach((value: Vector) => {
            min = Math.min(min, value.intensity);
            max = Math.max(max, value.intensity);
        });
        return [min, max];
    }

    /**
     * Get vector at any point using bilinear interpolation on irregular grid
     * @param λ Longitude
     * @param φ Latitude
     */
    get(λ: number, φ: number): Vector {

        // Normalize longitude for IDL crossing case and reuse cached arrays
        let queryLon = λ;
        if (this.crossesIDL) {
            // Bring any longitude into [0, 360)
            queryLon = ((λ % 360) + 360) % 360;
        }

        // Quick bounds check with small epsilon to tolerate float noise
        if (queryLon < this.lonMin - this.EPS || queryLon > this.lonMax + this.EPS || φ < this.latMin - this.EPS || φ > this.latMax + this.EPS) {
            return new Vector(0, 0, 0);
        }

        // Find the longitude indices that bracket the query point
        const lonIndices = this.findBracketingIndices(
            this.crossesIDL ? (this.unrolledLongitudes as number[]) : this.longitudes,
            queryLon,
            this.crossesIDL
        );
        const latIndices = this.findBracketingIndices(this.latitudes, φ, false);

        if (!lonIndices || !latIndices) {
            return new Vector(0, 0, 0);
        }

        const { i0: lonIdx0, i1: lonIdx1 } = lonIndices;
        const { i0: latIdx0, i1: latIdx1 } = latIndices;

        // Get the 4 corner points from the data array
        // Data is stored in row-major order: data[latIndex * width + lonIndex]
        const g00 = this.data[latIdx0 * this.width + lonIdx0];
        const g10 = this.data[latIdx0 * this.width + lonIdx1];
        const g01 = this.data[latIdx1 * this.width + lonIdx0];
        const g11 = this.data[latIdx1 * this.width + lonIdx1];

        if (!this.isValue(g00) || !this.isValue(g10) || !this.isValue(g01) || !this.isValue(g11)) {
            return new Vector(0, 0, 0);
        }

        // Corner coordinates
        let lon0 = this.longitudes[lonIdx0];
        let lon1 = this.longitudes[lonIdx1];

        // Normalize corners into [0, 360) for IDL case
        if (this.crossesIDL) {
            if (lon0 < 0) lon0 += 360;
            if (lon1 < 0) lon1 += 360;
        }

        const lat0 = this.latitudes[latIdx0];
        const lat1 = this.latitudes[latIdx1];

        // Interpolation weights using the same normalized longitude
        const tx = lon1 !== lon0 ? (queryLon - lon0) / (lon1 - lon0) : 0;
        const ty = lat1 !== lat0 ? (φ - lat0) / (lat1 - lat0) : 0;

        const x = Math.max(0, Math.min(1, tx));
        const y = Math.max(0, Math.min(1, ty));

        return this.interpolation(x, y, g00, g10, g01, g11);

    }

    /**
     * Find the two indices in a sorted array that bracket the given value
     * Returns null if value is out of bounds
     */
    private findBracketingIndices(arr: number[], value: number, normalizeForIDL: boolean = false): { i0: number, i1: number } | null {
        // If IDL, we search in the precomputed unrolled array
        if (normalizeForIDL) {
            const unrolled = this.unrolledLongitudes as number[];
            let sv = ((value % 360) + 360) % 360; // [0,360)
            if (sv + this.EPS < unrolled[0]) sv += 360;

            const minU = unrolled[0];
            const maxU = unrolled[unrolled.length - 1];

            if (sv < minU - this.EPS || sv > maxU + this.EPS) return null;

            // Binary search on strictly increasing array
            let left = 0, right = unrolled.length - 1;
            while (left < right - 1) {
                const mid = Math.floor((left + right) / 2);
                const mv = unrolled[mid];
                if (Math.abs(mv - sv) <= this.EPS) return { i0: mid, i1: mid };
                if (mv < sv) left = mid; else right = mid;
            }
            return { i0: left, i1: right };
        }

        // Non-IDL path (arr is original latitudes or original longitudes)
        const isAscending = (arr === this.latitudes) ? this.latAscending : this.lonAscending;
        const first = arr[0], last = arr[arr.length - 1];
        const minVal = Math.min(first, last);
        const maxVal = Math.max(first, last);

        if (value < minVal - this.EPS || value > maxVal + this.EPS) return null;

        let left = 0, right = arr.length - 1;
        while (left < right - 1) {
            const mid = Math.floor((left + right) / 2);
            const mv = arr[mid];
            if (Math.abs(mv - value) <= this.EPS) return { i0: mid, i1: mid };
            if (isAscending ? (mv < value) : (mv > value)) left = mid; else right = mid;
        }
        return { i0: left, i1: right };
    }

    /**
     * Bilinear interpolation
     */
    private interpolation(x: number, y: number, g00: Vector, g10: Vector, g01: Vector, g11: Vector): Vector {
        const rx = (1 - x);
        const ry = (1 - y);
        const a = rx * ry;
        const b = x * ry;
        const c = rx * y;
        const d = x * y;

        const u = g00.u * a + g10.u * b + g01.u * c + g11.u * d;
        const v = g00.v * a + g10.v * b + g01.v * c + g11.v * d;

        let wh = undefined;
        if (g00.waveHeight && g10.waveHeight && g01.waveHeight && g11.waveHeight) {
            wh = g00.waveHeight * a + g10.waveHeight * b + g01.waveHeight * c + g11.waveHeight * d;
            if (wh < 0) {
                wh = 0;
            }
        }

        return new Vector(u, v, wh);
    }

    private isValue(x: any): boolean {
        return x !== null && x !== undefined;
    }
}
