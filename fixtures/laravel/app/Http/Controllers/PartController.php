<?php

namespace App\Http\Controllers;

use App\Http\Requests\UpdatePriceRequest;
use App\Models\Part;

class PartController extends Controller
{
    public function updatePrice(UpdatePriceRequest $request, Part $part)
    {
        $part->update($request->validated());

        return $part;
    }

    public function destroy(Part $part)
    {
        $part->delete();

        return response()->noContent();
    }
}
