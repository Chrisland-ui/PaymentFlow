/**
 * TypeScript event catalog and strict type safety definitions for frontend analytics (Issue #270).
 */

export type AnalyticsEvent =
  | {
      name: 'PAYMENT_INSTRUCTIONS_VIEWED';
      properties: {
        className?: string;
        paymentStatus?: string;
        assetType?: string;
        studentIdPrefix?: string;
      };
    }
  | {
      name: 'PAYMENT_VERIFY_SUBMITTED';
      properties: {
        assetType?: string;
      };
    }
  | {
      name: 'PAYMENT_VERIFY_SUCCESS';
      properties: {
        assetType?: string;
        validationStatus?: string;
      };
    }
  | {
      name: 'PAYMENT_VERIFY_FAILED';
      properties: {
        errorCode?: string;
        assetType?: string;
      };
    }
  | {
      name: 'DISPUTE_SUBMIT_SUCCESS';
      properties: {
        disputeType?: string;
      };
    }
  | {
      name: 'DISPUTE_SUBMIT_FAILED';
      properties: {
        errorCode?: string;
      };
    }
  | {
      name: 'PAGINATION_PAGE_CHANGED';
      properties: {
        listName?: string;
        pageNumber?: number;
        pageSize?: number;
      };
    }
  | {
      name: 'SYNC_TRIGGERED';
      properties: {
        source?: string;
      };
    };

export const SCHEMA_VERSION: string;
export const EVENTS: Record<string, string>;
export const EVENT_CATALOG: Record<string, any>;

export function track<E extends AnalyticsEvent>(
  eventKey: E['name'],
  properties?: E['properties']
): void;

export function setAdapter(fn: (eventName: string, properties: Record<string, any>) => void): void;

export function validateEvent(
  eventKey: string,
  properties?: Record<string, any>
): { valid: boolean; errors: string[] };

export const analytics: {
  track: typeof track;
  setAdapter: typeof setAdapter;
  validateEvent: typeof validateEvent;
  EVENTS: typeof EVENTS;
  EVENT_CATALOG: typeof EVENT_CATALOG;
  SCHEMA_VERSION: string;
};

export default analytics;
