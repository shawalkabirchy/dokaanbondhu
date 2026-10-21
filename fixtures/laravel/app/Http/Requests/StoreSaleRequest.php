<?php

namespace App\Http\Requests;

use App\Rules\BangladeshPhone;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreSaleRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'customer_id' => 'nullable|integer|exists:customers,id',
            'items' => 'required|array|min:1',
            'items.*.part_id' => 'required|integer|exists:parts,id',
            'items.*.quantity' => 'required|integer|min:1|max:999',
            'items.*.unit_price' => 'nullable|numeric|min:0',
            'payment_method' => ['required', Rule::in(['cash', 'bkash', 'due'])],
            'sold_on' => 'sometimes|date',
            'note' => 'nullable|string|max:500',
            'tags' => 'sometimes|array',
            'tags.*' => 'string|max:20',
            'buyer_phone' => ['nullable', new BangladeshPhone()],
        ];
    }
}
