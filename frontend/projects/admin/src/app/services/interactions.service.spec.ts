import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
    HttpTestingController,
    provideHttpClientTesting,
} from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InteractionsService, Interaction } from './interactions.service';
import { environment } from '../../environments/environment';

describe('InteractionsService', () => {
    let service: InteractionsService;
    let httpMock: HttpTestingController;
    const base = `${environment.apiUrl}${environment.apiPrefix}/admin/interactions`;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [provideHttpClient(), provideHttpClientTesting(), InteractionsService],
        });
        service = TestBed.inject(InteractionsService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => httpMock.verify());

    it('lists with default pagination', () => {
        service.list().subscribe();
        const req = httpMock.expectOne((r) => r.url === base);
        expect(req.request.params.get('page')).toBe('1');
        expect(req.request.params.get('page_size')).toBe('20');
        expect(req.request.params.has('status')).toBe(false);
        expect(req.request.params.has('source')).toBe(false);
        req.flush({ items: [], total: 0, page: 1, pages: 1 });
    });

    it('passes filters and paging through', () => {
        service.list({ status: 'new', source: 'cv_request', page: 3, pageSize: 5 }).subscribe();
        const req = httpMock.expectOne((r) => r.url === base);
        expect(req.request.params.get('status')).toBe('new');
        expect(req.request.params.get('source')).toBe('cv_request');
        expect(req.request.params.get('page')).toBe('3');
        expect(req.request.params.get('page_size')).toBe('5');
        req.flush({ items: [], total: 0, page: 3, pages: 1 });
    });

    it('PATCHes a status update', () => {
        let result: Interaction | undefined;
        service.updateStatus('abc', 'closed').subscribe((r) => (result = r));
        const req = httpMock.expectOne(`${base}/abc`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({ status: 'closed' });
        req.flush({ id: 'abc', status: 'closed' });
        expect(result!.status).toBe('closed');
    });

    it('re-runs translation via POST (#248)', () => {
        service.rerunTranslation('i1').subscribe();
        const req = httpMock.expectOne(`${base}/i1/translate`);
        expect(req.request.method).toBe('POST');
        req.flush({ id: 'i1', translation_status: 'pending' });
    });
});
