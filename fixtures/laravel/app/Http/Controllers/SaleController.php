<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreSaleRequest;
use App\Models\Sale;
use Illuminate\Http\Request;

class SaleController extends Controller
{
    /** GET /sales: the list, filtered by query parameters. */
    public function index(Request $request)
    {
        $request->validate([
            'from' => 'nullable|date',
            'to' => 'nullable|date',
            'status' => 'nullable|in:posted,void',
        ]);

        return Sale::query()->latest()->paginate();
    }

    public function store(StoreSaleRequest $request)
    {
        return Sale::record($request->validated());
    }

    public function show(Sale $sale)
    {
        return $sale->load('items');
    }

    public function void(Request $request, Sale $sale)
    {
        $data = $this->validate($request, ['reason' => ['required', 'string', 'max:200']]);

        return $sale->void($data['reason']);
    }
}
