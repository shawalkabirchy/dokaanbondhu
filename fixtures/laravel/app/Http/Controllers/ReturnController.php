<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreReturnRequest;
use App\Models\SaleReturn;

class ReturnController extends Controller
{
    public function store(StoreReturnRequest $request)
    {
        return SaleReturn::record($request->validated());
    }
}
