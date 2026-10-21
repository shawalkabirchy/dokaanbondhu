<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\StockInRequest;
use App\Models\Purchase;

/** An invokable controller: its route's action is the class alone. */
class StockInController extends Controller
{
    public function __invoke(StockInRequest $request)
    {
        return Purchase::receive($request->validated());
    }
}
