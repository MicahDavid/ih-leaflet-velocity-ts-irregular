
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

        if (this.crossesIDL) {
            // For IDL crossing, normalize to 0-360 for bounds
            const normalizedLongs = longitudes.map(lng => lng < 0 ? lng + 360 : lng);
            this.lonMin = Math.min(...normalizedLongs);
            this.lonMax = Math.max(...normalizedLongs);
            //console.log('IrregularGrid: IDL crossing detected, normalized bounds:', this.lonMin, 'to', this.lonMax);
        } else {
            this.lonMin = Math.min(...longitudes);
            this.lonMax = Math.max(...longitudes);
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

        // Normalize longitude for IDL crossing case
        let queryLon = λ;
        if (this.crossesIDL && λ < 0) {
            queryLon = λ + 360;
        }

        // Quick bounds check
        if (queryLon < this.lonMin || queryLon > this.lonMax || φ < this.latMin || φ > this.latMax) {
            //if (shouldLog) {
            //    console.log('Out of bounds, returning zero vector');
            //}
            return new Vector(0, 0, 0);
        }


        // Find the longitude indices that bracket the query point
        const lonIndices = this.findBracketingIndices(this.longitudes, queryLon, this.crossesIDL);
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

        // Get actual coordinates of the 4 corners
        let lon0 = this.longitudes[lonIdx0];
        let lon1 = this.longitudes[lonIdx1];

        // Normalize corner longitudes for IDL case
        if (this.crossesIDL) {
            if (lon0 < 0) lon0 += 360;
            if (lon1 < 0) lon1 += 360;
        }

        const lat0 = this.latitudes[latIdx0];
        const lat1 = this.latitudes[latIdx1];

        // Calculate interpolation weights using the same normalized longitude
        const tx = lon1 !== lon0 ? (queryLon - lon0) / (lon1 - lon0) : 0;
        const ty = lat1 !== lat0 ? (φ - lat0) / (lat1 - lat0) : 0;

        // Clamp to [0, 1]
        const x = Math.max(0, Math.min(1, tx));
        const y = Math.max(0, Math.min(1, ty));

        const result = this.interpolation(x, y, g00, g10, g01, g11);

        return result;

    }

    /**
     * Find the two indices in a sorted array that bracket the given value
     * Returns null if value is out of bounds
     */
    private findBracketingIndices(arr: number[], value: number, normalizeForIDL: boolean = false): { i0: number, i1: number } | null {
        // Normalize array values if crossing IDL
        const searchArr = normalizeForIDL ? arr.map(lng => lng < 0 ? lng + 360 : lng) : arr;
        const searchValue = normalizeForIDL && value < 0 ? value + 360 : value;


        // Handle edge cases - check against BOTH ends regardless of order
        const minVal = Math.min(searchArr[0], searchArr[searchArr.length - 1]);
        const maxVal = Math.max(searchArr[0], searchArr[searchArr.length - 1]);

        if (searchValue < minVal || searchValue > maxVal) {
            return null;
        }

        // Determine if array is ascending or descending
        const isAscending = searchArr[0] < searchArr[searchArr.length - 1];

        // Binary search for efficiency
        let left = 0;
        let right = arr.length - 1;

        while (left < right - 1) {
            const mid = Math.floor((left + right) / 2);

            if (searchArr[mid] === searchValue) {
                return { i0: mid, i1: mid };
            }

            if (isAscending) {
                if (searchArr[mid] < searchValue) {
                    left = mid;
                } else {
                    right = mid;
                }
            } else {
                // Descending array
                if (searchArr[mid] > searchValue) {
                    left = mid;
                } else {
                    right = mid;
                }
            }
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
